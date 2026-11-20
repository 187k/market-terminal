import { describe, expect, it } from 'vitest';
import { applyLastPrice, spreadPct, summarizeCandles, type OhlcCandle } from './candles.js';

const c = (openTime: number, o: number, h: number, l: number, cl: number, v = 1, q: number | null = 10) =>
  ({ openTime, open: o, high: h, low: l, close: cl, volume: v, turnover: q }) satisfies OhlcCandle;

describe('applyLastPrice', () => {
  const candles = [c(0, 10, 12, 9, 11), c(60_000, 11, 13, 10, 12)];

  it('moves close and extends high / low of the forming candle', () => {
    const up = applyLastPrice(candles, 60_000, 14, 90_000);
    expect(up.at(-1)).toEqual(c(60_000, 11, 14, 10, 14));
    const down = applyLastPrice(candles, 60_000, 9.5, 90_000);
    expect(down.at(-1)).toEqual(c(60_000, 11, 13, 9.5, 9.5));
    expect(up[0]).toBe(candles[0]); // closed candles are untouched
  });

  it('keeps the volume the exchange reported', () => {
    expect(applyLastPrice(candles, 60_000, 12.5, 61_000).at(-1)!.volume).toBe(1);
  });

  it('ignores a price outside the forming period instead of inventing a new candle', () => {
    expect(applyLastPrice(candles, 60_000, 20, 120_000)).toBe(candles);
    expect(applyLastPrice(candles, 60_000, 20, 59_999)).toBe(candles);
  });

  it('ignores invalid prices and empty lists', () => {
    expect(applyLastPrice(candles, 60_000, 0, 90_000)).toBe(candles);
    expect(applyLastPrice(candles, 60_000, Number.NaN, 90_000)).toBe(candles);
    expect(applyLastPrice([], 60_000, 10, 0)).toEqual([]);
  });
});

describe('summarizeCandles', () => {
  it('summarises open, high, low, volume, turnover and change', () => {
    const s = summarizeCandles([c(0, 100, 110, 95, 105, 2, 200), c(1, 105, 120, 104, 118, 3, 350)]);
    expect(s).toEqual({
      open: 100,
      high: 120,
      low: 95,
      volume: 5,
      turnover: 550,
      changePct: 18,
      count: 2,
    });
  });

  it('measures change against a live price when given, and widens the range to include it', () => {
    const s = summarizeCandles([c(0, 100, 110, 95, 105)], 90);
    expect(s?.changePct).toBeCloseTo(-10, 10);
    expect(s?.low).toBe(90);
  });

  it('reports turnover as unknown when any candle lacks it', () => {
    expect(summarizeCandles([c(0, 1, 1, 1, 1, 1, 5), c(1, 1, 1, 1, 1, 1, null)])?.turnover).toBeNull();
  });

  it('returns null for no candles', () => {
    expect(summarizeCandles([])).toBeNull();
  });
});

describe('spreadPct', () => {
  it('is the ask premium over the bid in percent', () => {
    expect(spreadPct(100, 100.5)).toBeCloseTo(0.5, 10);
    expect(spreadPct(undefined, 1)).toBeNull();
  });
});
