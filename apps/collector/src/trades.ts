import { appendTrades, type Redis } from '@mip/bus';
import type { Logger, TradeEvent } from '@mip/core';
import { isZeroHash } from '@mip/connectors';

const FLUSH_MS = 250;
const MAX_BUFFERED = 20_000;

/**
 * Forwards public trades to the engine through a Redis Stream in small batches. Trades below
 * `minNotionalUsd` are dropped to keep the volume manageable; Hyperliquid TWAP slices (zero
 * hash) are always kept because they identify exchange-confirmed TWAP orders.
 */
export class TradeForwarder {
  #buffer: TradeEvent[] = [];
  #timer: NodeJS.Timeout | null = null;
  #forwarded = 0;
  #dropped = 0;
  readonly #log: Logger;

  constructor(
    private readonly redis: Redis,
    private readonly minNotionalUsd: number,
    logger: Logger,
  ) {
    this.#log = logger.child({ component: 'trades' });
  }

  push(t: TradeEvent): void {
    if (t.price * t.size < this.minNotionalUsd && !isZeroHash(t.hash)) {
      this.#dropped++;
      return;
    }
    this.#buffer.push(t);
    if (this.#buffer.length > MAX_BUFFERED) this.#buffer.splice(0, this.#buffer.length - MAX_BUFFERED);
  }

  start(): void {
    this.#timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer;
    this.#buffer = [];
    try {
      await appendTrades(this.redis, batch);
      this.#forwarded += batch.length;
    } catch (err) {
      this.#buffer = [...batch, ...this.#buffer].slice(-MAX_BUFFERED);
      this.#log.warn(
        { err: (err as Error).message, buffered: this.#buffer.length },
        'forwarding trades failed',
      );
    }
  }

  stats(): { forwarded: number; dropped: number } {
    return { forwarded: this.#forwarded, dropped: this.#dropped };
  }
}
