import type { ConnectionStateEvent, Logger } from '@mip/core';

/** The slice of the Prisma client this writer needs; keeps it testable without a database. */
export interface ConnectionEventSink {
  connectionEvent: {
    createMany(args: {
      data: { at: Date; exchange: string; connection: string; state: string; reason: string | null }[];
    }): Promise<unknown>;
    deleteMany(args: { where: { at: { lt: Date } } }): Promise<{ count: number }>;
  };
}

export interface EventWriterOptions {
  flushIntervalMs?: number;
  /** Events kept in memory while the database is unreachable; the oldest are dropped beyond this. */
  maxBuffered?: number;
  /** Delete events older than this many days (checked hourly); omit to keep everything. */
  retentionDays?: number;
  now?: () => number;
}

const PURGE_EVERY_MS = 3_600_000;

/** Buffers connection events and writes them in batches, surviving short database outages. */
export class ConnectionEventWriter {
  readonly #sink: ConnectionEventSink;
  readonly #log: Logger;
  readonly #maxBuffered: number;
  readonly #timer: NodeJS.Timeout;
  readonly #purgeTimer: NodeJS.Timeout | null;
  readonly #retentionDays: number | undefined;
  readonly #now: () => number;
  #buffer: ConnectionStateEvent[] = [];
  #flushing: Promise<void> | null = null;
  #dropped = 0;

  constructor(sink: ConnectionEventSink, logger: Logger, options: EventWriterOptions = {}) {
    this.#sink = sink;
    this.#log = logger.child({ component: 'event-writer' });
    this.#maxBuffered = options.maxBuffered ?? 5_000;
    this.#timer = setInterval(() => void this.flush(), options.flushIntervalMs ?? 1_000);
    this.#retentionDays = options.retentionDays;
    this.#now = options.now ?? Date.now;
    this.#purgeTimer =
      options.retentionDays === undefined ? null : setInterval(() => void this.purge(), PURGE_EVERY_MS);
    this.#purgeTimer?.unref();
  }

  /**
   * Deletes events older than the retention period. A reconnect loop (for example MEXC refused
   * through a VPN) writes tens of thousands of rows a day, so the table must not grow unbounded.
   */
  async purge(): Promise<number> {
    if (this.#retentionDays === undefined) return 0;
    try {
      const { count } = await this.#sink.connectionEvent.deleteMany({
        where: { at: { lt: new Date(this.#now() - this.#retentionDays * 86_400_000) } },
      });
      if (count > 0) this.#log.info({ deleted: count }, 'old connection events deleted');
      return count;
    } catch (err) {
      this.#log.warn({ err: (err as Error).message }, 'deleting old connection events failed');
      return 0;
    }
  }

  push(event: ConnectionStateEvent): void {
    this.#buffer.push(event);
    const overflow = this.#buffer.length - this.#maxBuffered;
    if (overflow > 0) {
      this.#buffer.splice(0, overflow);
      this.#dropped += overflow;
    }
  }

  get pending(): number {
    return this.#buffer.length;
  }

  async flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer;
    this.#buffer = [];
    this.#flushing = (async () => {
      try {
        await this.#sink.connectionEvent.createMany({
          data: batch.map((e) => ({
            at: new Date(e.at),
            exchange: e.exchange,
            connection: e.connection,
            state: e.state,
            reason: e.reason,
          })),
        });
        if (this.#dropped > 0) {
          this.#log.warn(
            { dropped: this.#dropped },
            'connection events were dropped during a database outage',
          );
          this.#dropped = 0;
        }
      } catch (err) {
        this.#log.error(
          { err: (err as Error).message, events: batch.length },
          'writing connection events failed; will retry',
        );
        this.#buffer = [...batch, ...this.#buffer];
        const overflow = this.#buffer.length - this.#maxBuffered;
        if (overflow > 0) {
          this.#buffer.splice(0, overflow);
          this.#dropped += overflow;
        }
      } finally {
        this.#flushing = null;
      }
    })();
    return this.#flushing;
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    if (this.#purgeTimer) clearInterval(this.#purgeTimer);
    await this.flush();
  }
}
