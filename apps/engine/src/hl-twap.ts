import { SubscriptionManager } from '@mip/connectors';
import type { Logger } from '@mip/core';

/** One TWAP order of a wallet, as reported by Hyperliquid's userTwapHistory subscription. */
export interface TwapOrder {
  coin: string;
  user: string;
  /** "B" buy, "A" sell. */
  side: string;
  /** Total order size, base units. */
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  randomize: boolean;
  reduceOnly: boolean;
  startedAt: number;
  status: 'activated' | 'terminated' | 'finished' | 'error' | string;
  statusAt: number;
}

interface HistoryEntry {
  state?: Record<string, unknown>;
  status?: { status?: string };
  time?: number;
}

export function parseTwapHistory(history: unknown): TwapOrder[] {
  if (!Array.isArray(history)) return [];
  const out: TwapOrder[] = [];
  for (const h of history as HistoryEntry[]) {
    const s = h.state;
    if (!s || typeof s.coin !== 'string' || typeof s.user !== 'string') continue;
    out.push({
      coin: s.coin,
      user: s.user,
      side: String(s.side),
      sz: Number(s.sz),
      executedSz: Number(s.executedSz),
      executedNtl: Number(s.executedNtl),
      minutes: Number(s.minutes),
      randomize: Boolean(s.randomize),
      reduceOnly: Boolean(s.reduceOnly),
      startedAt: Number(s.timestamp),
      status: h.status?.status ?? 'unknown',
      statusAt: Number(h.time ?? s.timestamp),
    });
  }
  return out;
}

/**
 * Follows the TWAP orders of wallets seen executing TWAP slices on Hyperliquid, through the
 * documented `userTwapHistory` subscription. Hyperliquid allows 10 unique users across
 * user-specific subscriptions per IP, so the least recently needed wallet is dropped first.
 */
export class HlTwapWatcher {
  readonly #orders = new Map<string, TwapOrder[]>();
  readonly #lastNeeded = new Map<string, number>();
  readonly #stream: SubscriptionManager;
  readonly #maxUsers: number;

  constructor(logger: Logger, options: { maxUsers?: number; url?: string } = {}) {
    this.#maxUsers = options.maxUsers ?? 10;
    const encode = (method: string) => (users: readonly string[]) =>
      users.map((user) => JSON.stringify({ method, subscription: { type: 'userTwapHistory', user } }));
    this.#stream = new SubscriptionManager({
      name: 'hyperliquid/twap-users',
      url: options.url ?? 'wss://api.hyperliquid.xyz/ws',
      maxTopicsPerConnection: this.#maxUsers,
      maxConnections: 1,
      logger,
      protocol: { subscribe: encode('subscribe'), unsubscribe: encode('unsubscribe') },
      sendRate: { limit: 5, windowMs: 1_000 },
      socket: { heartbeat: { intervalMs: 30_000, message: () => '{"method":"ping"}' } },
    });
    this.#stream.on('message', (m) => {
      let msg: { channel?: string; data?: { user?: string; history?: unknown; isSnapshot?: boolean } };
      try {
        msg = JSON.parse(m.text);
      } catch {
        return;
      }
      if (msg.channel !== 'userTwapHistory' || !msg.data?.user) return;
      const user = msg.data.user.toLowerCase();
      const incoming = parseTwapHistory(msg.data.history);
      const current = msg.data.isSnapshot ? [] : (this.#orders.get(user) ?? []);
      // Later entries for the same order (coin, side, start) replace earlier ones.
      const byKey = new Map(current.map((o) => [`${o.coin}:${o.side}:${o.startedAt}`, o]));
      for (const o of incoming) byKey.set(`${o.coin}:${o.side}:${o.startedAt}`, o);
      this.#orders.set(user, [...byKey.values()]);
    });
  }

  start(): void {
    this.#stream.start();
  }

  async stop(): Promise<void> {
    await this.#stream.stop();
  }

  /** Makes sure the wallet is followed (evicting the least recently needed one if full). */
  watch(user: string, now: number): void {
    const u = user.toLowerCase();
    this.#lastNeeded.set(u, now);
    const subscribed = new Set(this.#stream.topics());
    if (subscribed.has(u)) return;
    if (subscribed.size >= this.#maxUsers) {
      const oldest = [...subscribed].sort(
        (a, b) => (this.#lastNeeded.get(a) ?? 0) - (this.#lastNeeded.get(b) ?? 0),
      )[0];
      if (oldest) {
        this.#stream.remove([oldest]);
        this.#orders.delete(oldest);
      }
    }
    this.#stream.add([u]);
  }

  /** TWAP orders of a wallet; null while no snapshot has arrived yet. */
  orders(user: string): TwapOrder[] | null {
    return this.#orders.get(user.toLowerCase()) ?? null;
  }

  watched(): number {
    return this.#stream.topics().length;
  }
}
