import { describe, expect, it } from 'vitest';
import { perpAggregate, type PerpLeg } from './perps.js';

const leg = (key: string, v: Partial<PerpLeg> = {}): PerpLeg => ({
  key,
  mark: null,
  index: null,
  fundingRate: null,
  fundingIntervalHours: null,
  openInterest: null,
  openInterestBefore: null,
  multiplier: null,
  turnover24h: null,
  ...v,
});

describe('perpAggregate', () => {
  it('takes the median premium of (mark − index) / index', () => {
    const a = perpAggregate([
      leg('a', { mark: 101, index: 100 }),
      leg('b', { mark: 99, index: 100 }),
      leg('c', { mark: 100.5, index: 100 }),
      leg('d', { mark: 100 }), // no index: left out
    ]);
    expect(a.premiumPct).toBeCloseTo(0.5, 10);
  });

  it('normalises funding to 24 h with each leg’s own interval', () => {
    const a = perpAggregate([
      leg('8h', { fundingRate: 0.0001, fundingIntervalHours: 8 }), // 0.03 %/24h
      leg('1h', { fundingRate: 0.0001, fundingIntervalHours: 1 }), // 0.24 %/24h
      leg('4h', { fundingRate: -0.0002, fundingIntervalHours: 4 }), // −0.12 %/24h
      leg('none', { fundingRate: 0.01 }), // no interval: never assumed
    ]);
    expect(a.funding24hPct).toBeCloseTo(0.03, 10);
    expect(a.fundingLow?.key).toBe('4h');
    expect(a.fundingLow?.rate24hPct).toBeCloseTo(-0.12, 10);
    expect(a.fundingHigh?.key).toBe('1h');
  });

  it('reports no funding extremes with a single leg', () => {
    const a = perpAggregate([leg('a', { fundingRate: 0.0001, fundingIntervalHours: 8 })]);
    expect(a.funding24hPct).toBeCloseTo(0.03, 10);
    expect(a.fundingLow).toBeNull();
    expect(a.fundingHigh).toBeNull();
  });

  it('adds open interest as base units × mark (the multiplier cancels out)', () => {
    // 1000PEPE: 2,000 base units at 0.01 per base unit = 20; PEPE: 1,000,000 units at 0.00001 = 10.
    const a = perpAggregate([
      leg('k', { openInterest: 2_000, mark: 0.01, multiplier: 1000 }),
      leg('p', { openInterest: 1_000_000, mark: 0.00001, multiplier: 1 }),
      leg('nomark', { openInterest: 5 }),
    ]);
    expect(a.openInterestUsd).toBeCloseTo(30, 10);
    expect(a.oiKeys).toEqual(['k', 'p']);
  });

  it('measures the OI change on asset units over legs that have both values', () => {
    const a = perpAggregate([
      // 2,000 → 2,200 base units of 1000PEPE = 2.0 M → 2.2 M PEPE
      leg('k', { openInterest: 2_200, openInterestBefore: 2_000, multiplier: 1000 }),
      // 1.0 M → 0.9 M PEPE
      leg('p', { openInterest: 900_000, openInterestBefore: 1_000_000, multiplier: 1 }),
      // no baseline: not part of the comparison
      leg('new', { openInterest: 5_000_000, multiplier: 1 }),
    ]);
    // (3.1 M − 3.0 M) / 3.0 M
    expect(a.oiChangePct).toBeCloseTo(3.3333333, 5);
  });

  it('returns nulls, not zeros, when nothing is known', () => {
    expect(perpAggregate([leg('a'), leg('b')])).toEqual({
      premiumPct: null,
      funding24hPct: null,
      fundingLow: null,
      fundingHigh: null,
      openInterestUsd: null,
      oiKeys: [],
      oiChangePct: null,
      turnover24h: null,
    });
  });

  it('sums turnover', () => {
    expect(perpAggregate([leg('a', { turnover24h: 5 }), leg('b', { turnover24h: 7 })]).turnover24h).toBe(12);
  });
});
