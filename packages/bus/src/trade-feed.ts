import type { Logger, TradeEvent } from '@mip/core';
import type { Redis } from './redis.js';
import { readNewTrades, readTradesSince } from './trades.js';

/** Recent trades per instrument, oldest first, limited by time window and count. */
export class TradeBuffer {
  readonly #by = new Map<string, TradeEvent[]>();

  constructor(
    private windowMs: number,
    private readonly maxPerInstrument = 20_000,
  ) {}

  setWindow(ms: number): void {
    this.windowMs = ms;
  }

  add(trades: readonly TradeEvent[]): void {
    for (const t of trades) {
      const key = `${t.exchange}:${t.symbol}`;
      let list = this.#by.get(key);
      if (!list) this.#by.set(key, (list = []));
      // Streams can deliver slightly out of order across connections; keep the list sorted.
      if (list.length > 0 && t.ts < list[list.length - 1]!.ts) {
        const i = list.findIndex((x) => x.ts > t.ts);
        list.splice(i === -1 ? list.length : i, 0, t);
      } else list.push(t);
      if (list.length > this.maxPerInstrument) list.splice(0, list.length - this.maxPerInstrument);
    }
  }

  trim(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.#by) {
      const i = list.findIndex((t) => t.ts >= cutoff);
      if (i === -1) this.#by.delete(key);
      else if (i > 0) list.splice(0, i);
    }
  }

  get(exchange: string, symbol: string): TradeEvent[] {
    return this.#by.get(`${exchange}:${symbol}`) ?? [];
  }

  instruments(): string[] {
    return [...this.#by.keys()];
  }

  size(): number {
    let n = 0;
    for (const l of this.#by.values()) n += l.length;
    return n;
  }
}

/**
 * Consumes the collector's trade stream into a TradeBuffer. On start it re-reads the last
 * window from the stream, so a restarted reader (engine, API) keeps its trade history.
 */
export class TradeFeed {
  #running = false;
  #lastId = '0-0';
  #received = 0;
  readonly #log: Logger;

  constructor(
    private readonly redis: Redis,
    private readonly buffer: TradeBuffer,
    logger: Logger,
  ) {
    this.#log = logger.child({ component: 'trade-feed' });
  }

  get received(): number {
    return this.#received;
  }

  async start(sinceMs: number): Promise<number> {
    const initial = await readTradesSince(this.redis, sinceMs);
    this.buffer.add(initial.trades);
    this.#lastId = initial.lastId;
    this.#received += initial.trades.length;
    this.#running = true;
    void this.#loop();
    return initial.trades.length;
  }

  stop(): void {
    this.#running = false;
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      try {
        const r = await readNewTrades(this.redis, this.#lastId, 2_000);
        this.#lastId = r.lastId;
        this.#received += r.trades.length;
        this.buffer.add(r.trades);
      } catch (err) {
        if (!this.#running) return;
        this.#log.warn({ err: (err as Error).message }, 'reading trades failed; retrying');
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
}
