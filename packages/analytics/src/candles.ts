import { pctDiff } from './basic.js';

/** OHLCV candle (same shape as `Candle` in @mip/core; analytics has no dependencies). */
export interface OhlcCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
}

/**
 * Moves the forming candle with a live last price observed at `priceTs`. Only a price inside
 * the newest candle's period changes it (close, and high / low if exceeded); volume is left as
 * the exchange reported it. A price from after the period does not open a new candle: the
 * exchange's own candle (with its real open and volume) arrives with the next sync instead.
 * Returns the input unchanged when nothing applies.
 */
export function applyLastPrice<T extends OhlcCandle>(
  candles: readonly T[],
  intervalMs: number,
  price: number,
  priceTs: number,
): readonly T[] {
  const last = candles.at(-1);
  if (!last || !Number.isFinite(price) || price <= 0) return candles;
  if (priceTs < last.openTime || priceTs >= last.openTime + intervalMs) return candles;
  const updated: T = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  };
  return [...candles.slice(0, -1), updated];
}

export interface CandleSummary {
  open: number;
  high: number;
  low: number;
  volume: number;
  /** Null if any candle lacks turnover (a partial sum would understate it). */
  turnover: number | null;
  /** `lastPrice` (or the last close) against the first open, percent. */
  changePct: number | null;
  count: number;
}

/**
 * Open, high, low, volume and change over consecutive candles (oldest first), e.g. the last
 * 24 hourly candles for a 24 h summary. Null for an empty list.
 */
export function summarizeCandles(
  candles: readonly OhlcCandle[],
  lastPrice: number | null = null,
): CandleSummary | null {
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last) return null;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let turnover: number | null = 0;
  for (const c of candles) {
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
    volume += c.volume;
    turnover = turnover === null || c.turnover === null ? null : turnover + c.turnover;
  }
  const close = lastPrice ?? last.close;
  return {
    open: first.open,
    high: Math.max(high, close),
    low: Math.min(low, close),
    volume,
    turnover,
    changePct: pctDiff(close, first.open),
    count: candles.length,
  };
}

/** Relative width of the order-book spread: (ask − bid) / bid × 100. Null if a side is missing. */
export function spreadPct(bestBid: number | undefined, bestAsk: number | undefined): number | null {
  if (bestBid === undefined || bestAsk === undefined) return null;
  return pctDiff(bestAsk, bestBid);
}
