import type { CommonSettings, Logger, ScannerId, SignalDto, TelegramState } from '@mip/core';
import type { Candidate, FormatStatus, ScannerDefinition } from './scanners/types.js';

/** Persistence of signals (PostgreSQL in production, memory in tests). */
export interface SignalStore {
  insert(s: SignalDto): Promise<string>;
  update(s: SignalDto): Promise<void>;
  /** Active signals and signals resolved after `resolvedSince`, to rebuild state after a restart. */
  loadOpen(resolvedSince: number): Promise<SignalDto[]>;
}

/** Outbound notifications (Telegram in production). */
export interface SignalNotifier {
  /** Null when the scanner can send; otherwise why not (e.g. "no bot token configured"). */
  unavailableReason(scanner: ScannerId): string | null;
  send(scanner: ScannerId, html: string): Promise<number>;
  edit(scanner: ScannerId, messageId: number, html: string): Promise<void>;
}

interface Pending {
  since: number;
}

interface Tracked {
  dto: SignalDto;
  /** Value at the last notification (open or edit), for significance checks. */
  notifiedValue: number;
  notifiedAt: number;
  persistedAt: number;
  /** Serialises DB writes and Telegram calls per signal (insert before update, send before edit). */
  chain: Promise<void>;
  /** Last candidate, for scanner-specific significance checks. */
  candidate: Candidate;
}

interface ScannerState {
  pending: Map<string, Pending>;
  active: Map<string, Tracked>;
  /** Resolved signals still inside their cooldown, by key. */
  cooling: Map<string, Tracked>;
  /** Recently resolved signals for the dashboard, newest first. */
  recent: SignalDto[];
  dirty: boolean;
}

const RECENT_LIMIT = 50;
/** Unchanged active signals are written to the database at most this often (last-seen time). */
const PERSIST_EVERY_MS = 30_000;

export interface SignalEngineOptions {
  store: SignalStore;
  notifier: SignalNotifier;
  logger: Logger;
}

/**
 * Turns per-evaluation candidates into signals with a lifecycle:
 * pending (must persist `confirmSec`) → active (edits on significant change, throttled) →
 * resolved (absent `resolveAfterSec`) → cooling (reappearing within `cooldownMinutes` reopens the
 * same signal and message instead of announcing it again).
 */
export class SignalEngine {
  readonly #opts: SignalEngineOptions;
  readonly #log: Logger;
  readonly #defs = new Map<ScannerId, ScannerDefinition<any>>();
  readonly #states = new Map<ScannerId, ScannerState>();

  constructor(options: SignalEngineOptions) {
    this.#opts = options;
    this.#log = options.logger.child({ component: 'signals' });
  }

  register(def: ScannerDefinition<any>): void {
    this.#defs.set(def.id, def);
    this.#states.set(def.id, {
      pending: new Map(),
      active: new Map(),
      cooling: new Map(),
      recent: [],
      dirty: true,
    });
  }

  /** Rebuilds active and cooling signals from the store, so a restart announces nothing twice. */
  async restore(now: number, maxCooldownMs: number): Promise<number> {
    const rows = await this.#opts.store.loadOpen(now - maxCooldownMs);
    for (const dto of rows) {
      const st = this.#states.get(dto.scanner);
      if (!st) continue;
      const tracked: Tracked = {
        dto,
        notifiedValue: dto.value,
        notifiedAt: dto.lastSeenAt,
        persistedAt: dto.lastSeenAt,
        chain: Promise.resolve(),
        candidate: {
          key: dto.key,
          exchange: dto.exchange,
          symbol: dto.symbol,
          asset: dto.asset,
          direction: dto.direction,
          value: dto.value,
          title: dto.title,
          data: dto.data,
        },
      };
      if (dto.status === 'active') st.active.set(dto.key, tracked);
      else {
        st.cooling.set(dto.key, tracked);
        st.recent.push(dto);
      }
      st.dirty = true;
    }
    for (const st of this.#states.values())
      st.recent.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    return rows.length;
  }

  process(scanner: ScannerId, settings: CommonSettings, candidates: Candidate[], now: number): void {
    const def = this.#defs.get(scanner);
    const st = this.#states.get(scanner);
    if (!def || !st) throw new Error(`scanner ${scanner} not registered`);
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const active = st.active.get(c.key);
      if (active) {
        this.#update(def, settings, active, c, now);
        continue;
      }
      const cooling = st.cooling.get(c.key);
      if (
        cooling &&
        cooling.dto.resolvedAt !== null &&
        now - cooling.dto.resolvedAt < settings.cooldownMinutes * 60_000
      ) {
        this.#reopen(def, settings, st, cooling, c, now);
        continue;
      }
      const pending = st.pending.get(c.key) ?? { since: now };
      st.pending.set(c.key, pending);
      if (now - pending.since >= settings.confirmSec * 1000) {
        st.pending.delete(c.key);
        this.#open(def, settings, st, c, now);
      }
    }
    for (const key of st.pending.keys()) if (!seen.has(key)) st.pending.delete(key);
    for (const [key, t] of st.active) {
      if (!seen.has(key) && now - t.dto.lastSeenAt >= settings.resolveAfterSec * 1000) {
        this.#resolve(def, settings, st, t, now);
      }
    }
    for (const [key, t] of st.cooling) {
      if (t.dto.resolvedAt !== null && now - t.dto.resolvedAt >= settings.cooldownMinutes * 60_000)
        st.cooling.delete(key);
    }
  }

  active(scanner: ScannerId): SignalDto[] {
    const st = this.#states.get(scanner);
    return st ? [...st.active.values()].map((t) => t.dto).sort((a, b) => b.firstSeenAt - a.firstSeenAt) : [];
  }

  recent(scanner: ScannerId): SignalDto[] {
    return this.#states.get(scanner)?.recent ?? [];
  }

  /** True once per change; the publisher uses it to write only what changed. */
  takeDirty(scanner: ScannerId): boolean {
    const st = this.#states.get(scanner);
    if (!st?.dirty) return false;
    st.dirty = false;
    return true;
  }

  /** Waits for every queued database write and notification (tests, shutdown). */
  async settle(): Promise<void> {
    const chains: Promise<void>[] = [];
    for (const st of this.#states.values()) {
      for (const t of [...st.active.values(), ...st.cooling.values()]) chains.push(t.chain);
    }
    await Promise.all(chains);
  }

  // ---------------------------------------------------------------------------

  #open(
    def: ScannerDefinition<any>,
    settings: CommonSettings,
    st: ScannerState,
    c: Candidate,
    now: number,
  ): void {
    const reason = settings.notifyTelegram
      ? this.#opts.notifier.unavailableReason(def.id)
      : 'Telegram notifications are switched off for this scanner';
    const dto: SignalDto = {
      id: '',
      scanner: def.id,
      key: c.key,
      exchange: c.exchange,
      symbol: c.symbol,
      asset: c.asset,
      direction: c.direction,
      title: c.title,
      value: c.value,
      peakValue: Math.abs(c.value),
      status: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      updates: 0,
      data: c.data,
      telegram: { state: reason ? 'disabled' : 'queued', messageId: null, detail: reason },
    };
    const t: Tracked = {
      dto,
      notifiedValue: c.value,
      notifiedAt: now,
      persistedAt: now,
      chain: Promise.resolve(),
      candidate: c,
    };
    st.active.set(c.key, t);
    st.dirty = true;
    this.#log.info({ scanner: def.id, key: c.key, value: c.value }, 'signal opened');
    this.#enqueue(t, async () => {
      dto.id = await this.#opts.store.insert(dto);
    });
    if (!reason) {
      const html = def.format(dto, this.#status(dto, now));
      this.#enqueue(t, async () => {
        try {
          const messageId = await this.#opts.notifier.send(def.id, html);
          this.#setTelegram(st, t, 'sent', messageId, null);
        } catch (err) {
          this.#setTelegram(st, t, 'failed', null, (err as Error).message);
        }
        await this.#opts.store.update(dto);
      });
    }
  }

  #update(
    def: ScannerDefinition<any>,
    settings: CommonSettings,
    t: Tracked,
    c: Candidate,
    now: number,
  ): void {
    const dto = t.dto;
    dto.lastSeenAt = now;
    dto.value = c.value;
    dto.title = c.title;
    dto.data = c.data;
    dto.peakValue = Math.max(dto.peakValue, Math.abs(c.value));
    const significant = def.significantChange
      ? def.significantChange(t.candidate, c, settings)
      : relativeChange(t.notifiedValue, c.value) >= settings.significantChangePct / 100;
    t.candidate = c;
    const st = this.#states.get(def.id)!;
    st.dirty = true;
    if (significant && now - t.notifiedAt >= settings.minUpdateIntervalSec * 1000) {
      dto.updates++;
      t.notifiedValue = c.value;
      t.notifiedAt = now;
      t.persistedAt = now;
      this.#editMessage(def, st, t, now);
      this.#enqueue(t, () => this.#opts.store.update(dto));
    } else if (now - t.persistedAt >= PERSIST_EVERY_MS) {
      t.persistedAt = now;
      this.#enqueue(t, () => this.#opts.store.update(dto));
    }
  }

  #reopen(
    def: ScannerDefinition<any>,
    _settings: CommonSettings,
    st: ScannerState,
    t: Tracked,
    c: Candidate,
    now: number,
  ): void {
    st.cooling.delete(c.key);
    st.recent = st.recent.filter((r) => r !== t.dto);
    const dto = t.dto;
    Object.assign(dto, {
      status: 'active',
      resolvedAt: null,
      lastSeenAt: now,
      value: c.value,
      title: c.title,
      data: c.data,
    });
    dto.peakValue = Math.max(dto.peakValue, Math.abs(c.value));
    t.candidate = c;
    t.notifiedValue = c.value;
    t.notifiedAt = now;
    st.active.set(c.key, t);
    st.dirty = true;
    this.#log.info({ scanner: def.id, key: c.key }, 'signal reopened within cooldown');
    this.#editMessage(def, st, t, now);
    this.#enqueue(t, () => this.#opts.store.update(dto));
  }

  #resolve(
    def: ScannerDefinition<any>,
    settings: CommonSettings,
    st: ScannerState,
    t: Tracked,
    now: number,
  ): void {
    const dto = t.dto;
    dto.status = 'resolved';
    dto.resolvedAt = now;
    st.active.delete(dto.key);
    st.cooling.set(dto.key, t);
    st.recent.unshift(dto);
    if (st.recent.length > RECENT_LIMIT) st.recent.length = RECENT_LIMIT;
    st.dirty = true;
    this.#log.info({ scanner: def.id, key: dto.key }, 'signal resolved');
    if (settings.notifyResolved) this.#editMessage(def, st, t, now);
    this.#enqueue(t, () => this.#opts.store.update(dto));
  }

  #editMessage(def: ScannerDefinition<any>, st: ScannerState, t: Tracked, now: number): void {
    const dto = t.dto;
    if (dto.telegram.state !== 'sent' && dto.telegram.state !== 'queued') return;
    const html = def.format(dto, this.#status(dto, now));
    this.#enqueue(t, async () => {
      if (dto.telegram.messageId === null) return; // initial send failed or is not done
      try {
        await this.#opts.notifier.edit(def.id, dto.telegram.messageId, html);
      } catch (err) {
        this.#log.warn(
          { scanner: def.id, key: dto.key, err: (err as Error).message },
          'telegram edit failed',
        );
        this.#setTelegram(
          st,
          t,
          'sent',
          dto.telegram.messageId,
          `last edit failed: ${(err as Error).message}`,
        );
      }
    });
  }

  #setTelegram(
    st: ScannerState,
    t: Tracked,
    state: TelegramState,
    messageId: number | null,
    detail: string | null,
  ): void {
    t.dto.telegram = { state, messageId, detail };
    st.dirty = true;
  }

  #status(dto: SignalDto, now: number): FormatStatus {
    return { state: dto.status, firstSeenAt: dto.firstSeenAt, updatedAt: now, updates: dto.updates };
  }

  #enqueue(t: Tracked, task: () => Promise<void>): void {
    t.chain = t.chain.then(task).catch((err: unknown) => {
      this.#log.error({ key: t.dto.key, err: (err as Error).message }, 'signal task failed');
    });
  }
}

/** |next − previous| / max(|previous|, ε). */
export function relativeChange(previous: number, next: number): number {
  return Math.abs(next - previous) / Math.max(Math.abs(previous), 1e-9);
}
