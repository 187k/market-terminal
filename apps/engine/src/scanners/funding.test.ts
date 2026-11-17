import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  available,
  defaultSettings,
  MARKET_FIELDS,
  unavailable,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type Field,
  type FundingSettings,
  type InstrumentInfo,
  type MarketField,
  type UniverseInfo,
} from '@mip/core';
import type { HistoryPoint } from '../history.js';
import { buildView } from '../view.js';
import { evaluateFunding, formatFunding, lastSettlement, type FundingData } from './funding.js';

const defaults = defaultSettings('funding') as FundingSettings;
const NOW = 1_800_000_000_000;
const H = 3_600_000;

function fields(values: Partial<Record<MarketField, number>>): Record<MarketField, Field<number>> {
  return Object.fromEntries(
    MARKET_FIELDS.map((f) => [
      f,
      values[f] === undefined ? unavailable('not_received') : available(values[f]!, NOW),
    ]),
  ) as Record<MarketField, Field<number>>;
}

const noHistory = { series: () => [] as HistoryPoint[] };

/** One asset (BTC) on several exchanges with given funding rate / interval. */
function view(
  legs: { exchange: ExchangeId; symbol: string; rate: number; interval: number; quote?: string }[],
) {
  const snapshots: ExchangeMarketSnapshot[] = legs.map((l) => ({
    exchange: l.exchange,
    ts: NOW,
    rows: [
      {
        symbol: l.symbol,
        fields: fields({
          fundingRate: l.rate,
          fundingIntervalHours: l.interval,
          nextFundingTime: NOW + H,
          mark: 100,
          turnover24h: 1e8,
        }),
      },
    ],
  }));
  const universe: UniverseInfo = {
    source: 'coingecko',
    builtAt: NOW,
    size: 1,
    problems: [],
    warnings: [],
    assets: [
      {
        id: 'bitcoin',
        symbol: 'BTC',
        name: 'Bitcoin',
        rank: 1,
        marketCapRank: 1,
        marketCapUsd: 1,
        priceUsd: 100,
        instruments: legs.map((l) => ({ exchange: l.exchange, symbol: l.symbol })),
      },
    ],
  };
  const instruments = {
    ts: NOW,
    capabilities: {},
    instruments: Object.fromEntries(
      legs.map((l) => [
        l.exchange,
        [
          {
            exchange: l.exchange,
            symbol: l.symbol,
            quote: l.quote ?? 'USDT',
            url: `https://x/${l.symbol}`,
          } as InstrumentInfo,
        ],
      ]),
    ),
  };
  return buildView(snapshots, instruments, universe, NOW);
}

describe('funding normalisation and settlements', () => {
  it('normalises 1 h, 4 h and 8 h rates to 24 h using each contract’s interval', () => {
    const v = view([
      { exchange: 'hyperliquid', symbol: 'BTC', rate: 0.0000125, interval: 1, quote: 'USDC' },
      { exchange: 'gate', symbol: 'BTC_USDT', rate: 0.00005, interval: 4 },
      { exchange: 'bybit', symbol: 'BTCUSDT', rate: 0.0001, interval: 8 },
    ]);
    const r = evaluateFunding(v, { ...defaults, signalArbitrage: false, extreme24hPct: 0 }, noHistory);
    const by = Object.fromEntries(r.candidates.map((c) => [c.exchange, c.value]));
    expect(by.hyperliquid).toBeCloseTo(0.03, 12); // 0.00125 % × 24
    expect(by.gate).toBeCloseTo(0.03, 12); // 0.005 % × 6
    expect(by.bybit).toBeCloseTo(0.03, 12); // 0.01 % × 3
  });

  it('finds the last settlement: the rate before next-funding time moved forward', () => {
    const p = (ts: number, rate: number, next: number): HistoryPoint => ({
      ts,
      mark: null,
      last: null,
      openInterest: null,
      fundingRate: rate,
      fundingInterval: 8,
      nextFundingTime: next,
    });
    const series = [
      p(NOW - 3 * 60_000, 0.0002, NOW - 60_000),
      p(NOW - 2 * 60_000, 0.00021, NOW - 60_000),
      p(NOW - 60_000, 0.00005, NOW + 8 * H - 60_000),
    ];
    expect(lastSettlement(series)).toEqual({ at: NOW - 60_000, rate: 0.00021 });
    expect(lastSettlement(series.slice(0, 2))).toBeNull();
  });
});

describe('Funding scanner', () => {
  it('flags extreme funding with its sign', () => {
    const v = view([{ exchange: 'bybit', symbol: 'BTCUSDT', rate: 0.0015, interval: 8 }]);
    const c = evaluateFunding(v, defaults, noHistory).candidates;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ key: 'extreme:bybit:BTCUSDT:POSITIVE', direction: 'POSITIVE' });
    expect(c[0]!.value).toBeCloseTo(0.45, 12);
  });

  it('builds the funding arbitrage pair: long the lowest, short the highest 24 h funding', () => {
    const v = view([
      { exchange: 'hyperliquid', symbol: 'BTC', rate: -0.00004, interval: 1, quote: 'USDC' }, // −0.096 %/24h
      { exchange: 'bybit', symbol: 'BTCUSDT', rate: 0.0003, interval: 8 }, // +0.09 %/24h
      { exchange: 'gate', symbol: 'BTC_USDT', rate: 0.0001, interval: 8 },
    ]);
    const arb = evaluateFunding(v, { ...defaults, signalExtremes: false }, noHistory).candidates[0]!;
    expect(arb.key).toBe('arb:bitcoin:hyperliquid:bybit');
    expect(arb.value).toBeCloseTo(0.186, 9);
    const d = arb.data as FundingData;
    expect(d.mixedQuotes).toBe(true);
    const html = formatFunding(arb, { state: 'active', firstSeenAt: NOW, updatedAt: NOW, updates: 0 });
    expect(html).toContain('different schedules (every 1 h vs every 8 h)');
    expect(html).toContain('Different quote currencies (USDC vs USDT)');
    expect(html).toContain('estimates until settlement');
  });

  it('stays quiet below the thresholds', () => {
    const v = view([
      { exchange: 'bybit', symbol: 'BTCUSDT', rate: 0.0001, interval: 8 },
      { exchange: 'gate', symbol: 'BTC_USDT', rate: 0.00012, interval: 8 },
    ]);
    expect(evaluateFunding(v, defaults, noHistory).candidates).toHaveLength(0);
  });

  it('formats extremes with current and last settled rates', () => {
    const v = view([{ exchange: 'bybit', symbol: 'BTCUSDT', rate: -0.0015, interval: 8 }]);
    const settled: HistoryPoint[] = [
      {
        ts: NOW - 120_000,
        mark: null,
        last: null,
        openInterest: null,
        fundingRate: -0.001,
        fundingInterval: 8,
        nextFundingTime: NOW - 60_000,
      },
      {
        ts: NOW - 60_000,
        mark: null,
        last: null,
        openInterest: null,
        fundingRate: -0.0015,
        fundingInterval: 8,
        nextFundingTime: NOW + H,
      },
    ];
    const c = evaluateFunding(v, defaults, { series: () => settled }).candidates[0]!;
    const html = formatFunding(c, { state: 'active', firstSeenAt: NOW, updatedAt: NOW, updates: 0 });
    expect(html).toContain('Current (estimate for the next settlement)');
    expect(html).toContain('Last settled: −0.1000 %');
    expect(html).toContain('Shorts pay longs.');
  });
});

describe('Funding scanner on a recorded market view (real data)', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/market-view.json', import.meta.url), 'utf8'));
  const now = Math.max(...fx.snapshots.map((s: { ts: number }) => s.ts)) + 500;
  const v = buildView(fx.snapshots, fx.instruments, fx.universe, now);

  it('normalises every leg with its own interval', () => {
    const r = evaluateFunding(
      v,
      { ...defaults, extreme24hPct: 0, signalArbitrage: false, minTurnover24hUsd: 0 },
      noHistory,
    );
    expect(r.evaluated).toBeGreaterThan(30);
    const intervals = new Set<number>();
    for (const c of r.candidates) {
      const leg = (c.data as FundingData).leg!;
      intervals.add(leg.intervalHours);
      expect(leg.rate24h).toBeCloseTo((leg.rate * 24) / leg.intervalHours, 15);
    }
    expect(intervals.has(1)).toBe(true); // Hyperliquid
    expect(intervals.has(8)).toBe(true);
  });
});
