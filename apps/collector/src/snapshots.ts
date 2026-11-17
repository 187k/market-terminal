import type { ExchangeId, ExchangeMarketSnapshot, Logger } from '@mip/core';
import type { Prisma, PrismaClient } from '@mip/db';
import type { MarketState } from './market-state.js';

const MINUTE = 60_000;

/** Rows for one minute from evaluated snapshots: only fresh values, NULL otherwise. */
export function snapshotRows(
  snapshots: ExchangeMarketSnapshot[],
  minute: number,
): Prisma.MarketSnapshotCreateManyInput[] {
  const ts = new Date(minute);
  const rows: Prisma.MarketSnapshotCreateManyInput[] = [];
  for (const s of snapshots) {
    for (const r of s.rows) {
      const v = (k: keyof typeof r.fields) => (r.fields[k].available ? r.fields[k].value : null);
      const row = {
        ts,
        exchange: s.exchange,
        symbol: r.symbol,
        mark: v('mark'),
        last: v('last'),
        openInterest: v('openInterest'),
        fundingRate: v('fundingRate'),
        fundingInterval: v('fundingIntervalHours'),
        nextFundingTime: v('nextFundingTime') === null ? null : new Date(v('nextFundingTime')!),
        turnover24h: v('turnover24h'),
      };
      // A row with nothing fresh carries no information.
      if (row.mark !== null || row.last !== null || row.openInterest !== null || row.fundingRate !== null)
        rows.push(row);
    }
  }
  return rows;
}

/**
 * Writes one snapshot per tracked instrument at the start of every minute and deletes rows
 * older than the retention period. History for the OI windows and funding settlements.
 */
export class SnapshotWriter {
  readonly #log: Logger;
  #timer: NodeJS.Timeout | null = null;
  #lastPurge = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly state: MarketState,
    logger: Logger,
    private readonly retentionDays: number,
  ) {
    this.#log = logger.child({ component: 'snapshots' });
  }

  start(): void {
    const schedule = () => {
      const now = Date.now();
      // a couple of seconds after the minute starts, so the minute bucket is unambiguous
      const next = Math.floor(now / MINUTE) * MINUTE + MINUTE + 2_000;
      this.#timer = setTimeout(() => {
        void this.writeMinute(Math.floor(Date.now() / MINUTE) * MINUTE).finally(schedule);
      }, next - now);
    };
    schedule();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
  }

  async writeMinute(minute: number): Promise<number> {
    const exchanges: ExchangeId[] = this.state.exchanges().filter((e) => this.state.tracked(e).length > 0);
    const rows = snapshotRows(
      exchanges.map((e) => this.state.snapshot(e)),
      minute,
    );
    try {
      if (rows.length > 0) await this.prisma.marketSnapshot.createMany({ data: rows, skipDuplicates: true });
      if (Date.now() - this.#lastPurge > 3_600_000) {
        this.#lastPurge = Date.now();
        const { count } = await this.prisma.marketSnapshot.deleteMany({
          where: { ts: { lt: new Date(Date.now() - this.retentionDays * 86_400_000) } },
        });
        if (count > 0) this.#log.info({ deleted: count }, 'old market snapshots deleted');
      }
    } catch (err) {
      this.#log.warn({ err: (err as Error).message, rows: rows.length }, 'writing market snapshots failed');
    }
    return rows.length;
  }
}
