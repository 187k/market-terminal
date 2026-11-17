import type { PrismaClient } from '@mip/db';

/** One per-minute snapshot of an instrument (fresh values only; null = was not fresh). */
export interface HistoryPoint {
  ts: number;
  mark: number | null;
  last: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  fundingInterval: number | null;
  nextFundingTime: number | null;
}

export interface HistoryRow extends HistoryPoint {
  exchange: string;
  symbol: string;
}

export interface HistorySource {
  /** Rows with ts > `afterTs`, oldest first. */
  since(afterTs: number): Promise<HistoryRow[]>;
}

export function prismaHistorySource(prisma: PrismaClient): HistorySource {
  return {
    async since(afterTs) {
      const rows = await prisma.marketSnapshot.findMany({
        where: { ts: { gt: new Date(afterTs) } },
        orderBy: { ts: 'asc' },
        select: {
          ts: true,
          exchange: true,
          symbol: true,
          mark: true,
          last: true,
          openInterest: true,
          fundingRate: true,
          fundingInterval: true,
          nextFundingTime: true,
        },
      });
      return rows.map((r) => ({
        ...r,
        ts: r.ts.getTime(),
        nextFundingTime: r.nextFundingTime?.getTime() ?? null,
      }));
    },
  };
}

/**
 * The last `windowMs` of per-minute snapshots, in memory, per instrument. Loaded from the
 * database at start-up (so windows survive restarts) and topped up with new rows.
 */
export class SnapshotHistory {
  readonly #series = new Map<string, HistoryPoint[]>();
  #lastTs = 0;
  #firstTs: number | null = null;

  constructor(
    private readonly source: HistorySource,
    private readonly windowMs: number,
  ) {}

  /** Loads (first call) or appends new snapshots; drops points older than the window. */
  async refresh(now: number): Promise<number> {
    const rows = await this.source.since(this.#lastTs || now - this.windowMs);
    for (const r of rows) {
      const key = `${r.exchange}:${r.symbol}`;
      const list = this.#series.get(key) ?? [];
      list.push({
        ts: r.ts,
        mark: r.mark,
        last: r.last,
        openInterest: r.openInterest,
        fundingRate: r.fundingRate,
        fundingInterval: r.fundingInterval,
        nextFundingTime: r.nextFundingTime,
      });
      this.#series.set(key, list);
      if (r.ts > this.#lastTs) this.#lastTs = r.ts;
      if (this.#firstTs === null || r.ts < this.#firstTs) this.#firstTs = r.ts;
    }
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.#series) {
      const i = list.findIndex((p) => p.ts >= cutoff);
      if (i === -1) this.#series.delete(key);
      else if (i > 0) list.splice(0, i);
    }
    if (this.#firstTs !== null && this.#firstTs < cutoff) this.#firstTs = cutoff;
    return rows.length;
  }

  series(exchange: string, symbol: string): HistoryPoint[] {
    return this.#series.get(`${exchange}:${symbol}`) ?? [];
  }

  /** How far back the history reaches (0 if empty). */
  coverageMs(now: number): number {
    return this.#firstTs === null ? 0 : now - this.#firstTs;
  }
}
