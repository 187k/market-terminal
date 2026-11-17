import { describe, expect, it } from 'vitest';
import { coefficientOfVariation, mean, median, pctDiff, stdev } from './basic.js';
import { fairPriceMetrics } from './fair-price.js';
import { bestFundingPair, funding24h } from './funding.js';
import { oiChange, oiScenario, sampleAt } from './open-interest.js';
import { grossSpreadPct, profit, vwap } from './spread.js';

describe('basic', () => {
  it('pctDiff', () => {
    expect(pctDiff(101, 100)).toBeCloseTo(1, 12);
    expect(pctDiff(99, 100)).toBeCloseTo(-1, 12);
    expect(pctDiff(1, 0)).toBeNull();
    expect(pctDiff(Number.NaN, 1)).toBeNull();
  });
  it('statistics', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(coefficientOfVariation([10, 10, 10])).toBe(0);
    expect(mean([])).toBeNull();
    expect(stdev([1])).toBeNull();
  });
});

describe('fair price', () => {
  const base = { index: 100.2, bid: 99.4, ask: 99.5, bidSize: 10, askSize: 20 };
  it('market below fair is LONG; deviation = (last − mark) / mark × 100', () => {
    const m = fairPriceMetrics({ ...base, last: 99.5, mark: 100 })!;
    expect(m.direction).toBe('LONG');
    expect(m.deviationPct).toBeCloseTo(-0.5, 12);
    // can still buy at 99.5, 0.5 % below mark
    expect(m.executableEdgePct).toBeCloseTo(0.5, 12);
    expect(m.fairVsIndexPct).toBeCloseTo(((100 - 100.2) / 100.2) * 100, 12);
    expect(m.spreadPct).toBeCloseTo((0.1 / 99.45) * 100, 12);
    expect(m.topOfBookUsd).toBeCloseTo(99.5 * 20, 9); // ask side for LONG
  });
  it('market above fair is SHORT; executable edge uses the bid', () => {
    const m = fairPriceMetrics({ ...base, last: 101, mark: 100, bid: 100.6, ask: 100.7 })!;
    expect(m.direction).toBe('SHORT');
    expect(m.deviationPct).toBeCloseTo(1, 12);
    expect(m.executableEdgePct).toBeCloseTo(0.6, 9);
    expect(m.topOfBookUsd).toBeCloseTo(100.6 * 10, 9);
  });
  it('a stale last trade with the book back at fair has no executable edge', () => {
    const m = fairPriceMetrics({ ...base, last: 98, mark: 100, bid: 99.99, ask: 100.01 })!;
    expect(m.deviationPct).toBeCloseTo(-2, 12);
    expect(m.executableEdgePct).toBeCloseTo(-0.01, 9);
  });
  it('handles missing book and index', () => {
    const m = fairPriceMetrics({
      last: 1,
      mark: 2,
      index: null,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
    })!;
    expect(m).toMatchObject({
      executableEdgePct: null,
      fairVsIndexPct: null,
      spreadPct: null,
      topOfBookUsd: null,
    });
    expect(fairPriceMetrics({ ...base, last: 1, mark: 0 })).toBeNull();
  });
});

describe('funding', () => {
  it('normalises to 24 h with the real interval', () => {
    expect(funding24h(0.0001, 8)).toBeCloseTo(0.0003, 15);
    expect(funding24h(0.0001, 4)).toBeCloseTo(0.0006, 15);
    expect(funding24h(0.0000125, 1)).toBeCloseTo(0.0003, 15);
    expect(funding24h(0.0001, 0)).toBeNull();
  });
  it('picks long on the lowest and short on the highest 24 h funding', () => {
    const p = bestFundingPair([
      { key: 'a', rate24h: 0.0003 },
      { key: 'b', rate24h: -0.0009 },
      { key: 'c', rate24h: 0.0012 },
    ])!;
    expect(p.long.key).toBe('b');
    expect(p.short.key).toBe('c');
    expect(p.difference24h).toBeCloseTo(0.0021, 15);
    expect(bestFundingPair([{ key: 'a', rate24h: 1 }])).toBeNull();
  });
});

describe('open interest', () => {
  const series = [0, 60, 120, 180, 240].map((s) => ({ ts: s * 1000, value: s }));
  it('finds the sample nearest a time within tolerance, never interpolates', () => {
    expect(sampleAt(series, 125_000, 10_000)).toEqual({ ts: 120_000, value: 120 });
    expect(sampleAt(series, 90_000, 10_000)).toBeNull();
    expect(sampleAt(series, -5_000, 10_000)).toEqual({ ts: 0, value: 0 });
    expect(sampleAt([], 1, 1)).toBeNull();
  });
  it('computes change in percent, coins and USD', () => {
    const c = oiChange(1100, 1000, 50)!;
    expect(c).toMatchObject({
      changePct: 10,
      changeBase: 100,
      changeUsd: 5000,
      previous: 1000,
      current: 1100,
    });
    expect(oiChange(1, 0, 1)).toBeNull();
  });
  it('classifies the four scenarios', () => {
    expect(oiScenario(1, 1)).toBe(1);
    expect(oiScenario(-1, 1)).toBe(2);
    expect(oiScenario(1, -1)).toBe(3);
    expect(oiScenario(-1, -1)).toBe(4);
    expect(oiScenario(0, 1)).toBeNull();
  });
});

describe('spread and profit', () => {
  const asks = [
    [100, 1],
    [101, 2],
    [102, 5],
  ] as const;
  it('VWAP walks the book', () => {
    expect(vwap(asks, 1)).toEqual({ vwap: 100, filledQty: 1, complete: true });
    expect(vwap(asks, 2)!.vwap).toBeCloseTo(100.5, 12);
    expect(vwap(asks, 3)!.vwap).toBeCloseTo((100 + 202) / 3, 12);
    const short = vwap(asks, 10)!;
    expect(short.complete).toBe(false);
    expect(short.filledQty).toBe(8);
    expect(vwap([], 1)).toBeNull();
  });
  it('gross spread from buy and sell prices', () => {
    expect(grossSpreadPct(100, 101)).toBeCloseTo(1, 12);
    expect(grossSpreadPct(0, 1)).toBeNull();
  });
  it('net profit follows the specified steps', () => {
    const p = profit({
      qty: 10,
      buyPrice: 100,
      sellPrice: 101,
      buyFeeRate: 0.0005,
      sellFeeRate: 0.0006,
      fundingCost: 0.2,
    });
    expect(p.purchaseCost).toBe(1000);
    expect(p.saleProceeds).toBe(1010);
    expect(p.grossProfit).toBe(10);
    expect(p.fees).toBeCloseTo(0.5 + 0.606, 12);
    expect(p.netProfit).toBeCloseTo(10 - 1.106 - 0.2, 12);
    expect(p.netPct).toBeCloseTo((8.694 / 1000) * 100, 9);
  });
});
