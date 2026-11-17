import { pctDiff } from './basic.js';

export type Direction = 'LONG' | 'SHORT';

export interface FairPriceInput {
  last: number;
  mark: number;
  index: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export interface FairPriceMetrics {
  /** (last − mark) / mark × 100, the specified deviation. */
  deviationPct: number;
  /** Market below fair → LONG, above → SHORT. An analytical signal, not a recommendation. */
  direction: Direction;
  /**
   * What can actually be traded now, relative to the mark: for LONG (mark − ask) / mark × 100,
   * for SHORT (bid − mark) / mark × 100. Positive = the book still offers the deviation.
   */
  executableEdgePct: number | null;
  /** (mark − index) / index × 100. */
  fairVsIndexPct: number | null;
  /** (ask − bid) / mid × 100. */
  spreadPct: number | null;
  /** Notional at the best level on the side you would take (ask for LONG, bid for SHORT), quote currency. */
  topOfBookUsd: number | null;
}

/**
 * Fair-price deviation as specified for bot #1 plus the figures that tell whether it is
 * tradable. Returns null when the deviation is undefined (zero or invalid mark).
 */
export function fairPriceMetrics(x: FairPriceInput): FairPriceMetrics | null {
  const deviationPct = pctDiff(x.last, x.mark);
  if (deviationPct === null) return null;
  const direction: Direction = deviationPct < 0 ? 'LONG' : 'SHORT';
  let executableEdgePct: number | null = null;
  if (direction === 'LONG' && x.ask !== null) executableEdgePct = ((x.mark - x.ask) / x.mark) * 100;
  if (direction === 'SHORT' && x.bid !== null) executableEdgePct = ((x.bid - x.mark) / x.mark) * 100;
  const mid = x.bid !== null && x.ask !== null ? (x.bid + x.ask) / 2 : null;
  const spreadPct = mid !== null && mid > 0 ? ((x.ask! - x.bid!) / mid) * 100 : null;
  const side = direction === 'LONG' ? [x.ask, x.askSize] : [x.bid, x.bidSize];
  const topOfBookUsd = side[0] !== null && side[1] !== null ? side[0]! * side[1]! : null;
  return {
    deviationPct,
    direction,
    executableEdgePct,
    fairVsIndexPct: x.index === null ? null : pctDiff(x.mark, x.index),
    spreadPct,
    topOfBookUsd,
  };
}
