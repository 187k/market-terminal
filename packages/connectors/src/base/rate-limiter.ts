import { systemNow, type Now } from '@mip/core';

/** "At most `limit` units of weight in any `windowMs` interval." */
export interface WindowLimit {
  limit: number;
  windowMs: number;
}

export type Priority = 'high' | 'normal' | 'low';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export interface RateLimiterOptions {
  name: string;
  /** All windows must allow a request before it proceeds (e.g. per-second and per-minute limits). */
  windows: WindowLimit[];
  /** Fraction of each limit we allow ourselves to use (default 0.8), leaving room for clock skew and other clients. */
  headroom?: number;
  now?: Now;
}

export interface RateLimiterStats {
  name: string;
  queued: number;
  pausedUntil: number | null;
  windows: { limit: number; effectiveLimit: number; windowMs: number; used: number }[];
}

const SHARED = new Map<string, RateLimiter>();
const PENDING_PAUSES = new Map<string, number>();

/**
 * One limiter per name for the whole process. Exchange limits and bans apply to our IP, not
 * to a connector instance, so a restarted connector must inherit the previous one's usage and
 * any pause (e.g. a Binance 418 ban) instead of starting with a clean slate.
 */
export function sharedRateLimiter(options: RateLimiterOptions): RateLimiter {
  let limiter = SHARED.get(options.name);
  if (!limiter) {
    limiter = new RateLimiter(options);
    SHARED.set(options.name, limiter);
    const until = PENDING_PAUSES.get(options.name);
    PENDING_PAUSES.delete(options.name);
    if (until !== undefined) limiter.pause(until - (options.now ?? Date.now)());
  }
  return limiter;
}

/**
 * Holds every request of a shared limiter until `untilMs`, even if the limiter does not exist
 * yet. Used at start-up to honour a ban recorded by a previous process: requests sent during a
 * ban make exchanges extend it (Binance: from minutes up to days for repeat offenders).
 */
export function pauseSharedLimiter(name: string, untilMs: number): void {
  const limiter = SHARED.get(name);
  if (limiter) limiter.pause(untilMs - Date.now());
  else PENDING_PAUSES.set(name, Math.max(untilMs, PENDING_PAUSES.get(name) ?? 0));
}

export class RateLimitAbortedError extends Error {
  constructor(message = 'rate limiter wait aborted') {
    super(message);
    this.name = 'RateLimitAbortedError';
  }
}

interface Entry {
  t: number;
  cost: number;
}

interface Window {
  limit: number;
  effectiveLimit: number;
  windowMs: number;
  log: Entry[];
  used: number;
}

interface Waiter {
  cost: number;
  rank: number;
  seq: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/**
 * Sliding-window rate limiter. Unlike a token bucket it can never exceed `limit`
 * within any window, which matches how exchanges enforce fixed and rolling windows.
 * Waiters are served by priority, then FIFO.
 */
export class RateLimiter {
  readonly name: string;
  readonly #windows: Window[];
  readonly #now: Now;
  #queue: Waiter[] = [];
  #timer: NodeJS.Timeout | null = null;
  #pausedUntil = 0;
  #seq = 0;

  constructor(options: RateLimiterOptions) {
    if (options.windows.length === 0)
      throw new Error(`RateLimiter ${options.name}: at least one window required`);
    const headroom = options.headroom ?? 0.8;
    if (!(headroom > 0 && headroom <= 1)) throw new Error('headroom must be in (0, 1]');
    this.name = options.name;
    this.#now = options.now ?? systemNow;
    this.#windows = options.windows.map((w) => ({
      limit: w.limit,
      effectiveLimit: Math.max(1, Math.floor(w.limit * headroom)),
      windowMs: w.windowMs,
      log: [],
      used: 0,
    }));
  }

  /** Waits until `cost` units fit into every window, then consumes them. */
  acquire(cost = 1, options: { priority?: Priority; signal?: AbortSignal } = {}): Promise<void> {
    const tooBig = this.#windows.find((w) => cost > w.effectiveLimit);
    if (tooBig) {
      return Promise.reject(
        new Error(
          `${this.name}: cost ${cost} exceeds window limit ${tooBig.effectiveLimit}/${tooBig.windowMs}ms`,
        ),
      );
    }
    if (options.signal?.aborted) return Promise.reject(new RateLimitAbortedError());

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        cost,
        rank: PRIORITY_RANK[options.priority ?? 'normal'],
        seq: this.#seq++,
        resolve,
        reject,
        signal: options.signal,
        onAbort: undefined,
      };
      if (options.signal) {
        waiter.onAbort = () => {
          this.#queue = this.#queue.filter((w) => w !== waiter);
          reject(new RateLimitAbortedError());
          this.#drain();
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#insert(waiter);
      this.#drain();
    });
  }

  /** Consumes `cost` immediately if it fits and nobody is waiting; never waits. */
  tryAcquire(cost = 1): boolean {
    if (this.#queue.length > 0 || this.#now() < this.#pausedUntil) return false;
    const now = this.#now();
    if (this.#windows.some((w) => this.#waitFor(w, cost, now) > 0)) return false;
    this.#consume(cost, now);
    return true;
  }

  /** Holds every request back for `ms` (e.g. after HTTP 429 or a ban). Extends, never shortens, a pause. */
  pause(ms: number): void {
    const until = this.#now() + Math.max(0, ms);
    if (until > this.#pausedUntil) {
      this.#pausedUntil = until;
      this.#reschedule();
    }
  }

  get pausedUntil(): number | null {
    return this.#pausedUntil > this.#now() ? this.#pausedUntil : null;
  }

  stats(): RateLimiterStats {
    const now = this.#now();
    return {
      name: this.name,
      queued: this.#queue.length,
      pausedUntil: this.pausedUntil,
      windows: this.#windows.map((w) => {
        this.#expire(w, now);
        return { limit: w.limit, effectiveLimit: w.effectiveLimit, windowMs: w.windowMs, used: w.used };
      }),
    };
  }

  /** Rejects all waiters; used on shutdown. */
  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const waiting = this.#queue;
    this.#queue = [];
    for (const w of waiting) {
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.reject(new RateLimitAbortedError(`${this.name}: limiter closed`));
    }
  }

  #insert(waiter: Waiter): void {
    const i = this.#queue.findIndex((w) => w.rank > waiter.rank);
    if (i === -1) this.#queue.push(waiter);
    else this.#queue.splice(i, 0, waiter);
  }

  #drain(): void {
    for (;;) {
      const head = this.#queue[0];
      if (!head) return this.#clearTimer();
      const now = this.#now();
      const wait = Math.max(
        this.#pausedUntil - now,
        ...this.#windows.map((w) => this.#waitFor(w, head.cost, now)),
      );
      if (wait > 0) return this.#schedule(wait);
      this.#queue.shift();
      if (head.onAbort) head.signal?.removeEventListener('abort', head.onAbort);
      this.#consume(head.cost, now);
      head.resolve();
    }
  }

  #consume(cost: number, now: number): void {
    for (const w of this.#windows) {
      w.log.push({ t: now, cost });
      w.used += cost;
    }
  }

  #expire(w: Window, now: number): void {
    while (w.log.length > 0 && w.log[0]!.t + w.windowMs <= now) w.used -= w.log.shift()!.cost;
  }

  /** Milliseconds until `cost` fits into window `w` (0 if it fits now). */
  #waitFor(w: Window, cost: number, now: number): number {
    this.#expire(w, now);
    let excess = w.used + cost - w.effectiveLimit;
    if (excess <= 0) return 0;
    for (const entry of w.log) {
      excess -= entry.cost;
      if (excess <= 0) return entry.t + w.windowMs - now;
    }
    return w.windowMs; // unreachable when cost <= effectiveLimit
  }

  #schedule(ms: number): void {
    this.#clearTimer();
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#drain();
      },
      Math.max(1, Math.ceil(ms)),
    );
  }

  #reschedule(): void {
    if (this.#queue.length > 0) this.#drain();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
