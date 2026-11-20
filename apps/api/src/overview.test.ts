import { describe, expect, it } from 'vitest';
import type { StoredInstruments, StoredMarketOverview } from '@mip/bus';
import {
  MARKET_FIELDS,
  unavailable,
  type CoinSpotStats,
  type ExchangeMarketSnapshot,
  type Field,
  type InstrumentInfo,
  type MarketField,
  type UniverseInfo,
} from '@mip/core';
import { buildOverviewResponse, buildPerpOverview, OVERVIEW_STALE_POLLS, pickBaseline } from './overview.js';

const universe = (source: UniverseInfo['source'] = 'coingecko'): UniverseInfo => ({
  source,
  builtAt: 1,
  size: 2,
  problems: [],
  warnings: [],
  assets: [
    {
      id: 'bitcoin',
      symbol: 'BTC',
      name: 'Bitcoin',
      rank: 1,
      marketCapRank: 1,
      marketCapUsd: null,
      priceUsd: null,
      instruments: [
        { exchange: 'bybit', symbol: 'BTCUSDT' },
        { exchange: 'hyperliquid', symbol: 'BTC' },
        { exchange: 'gate', symbol: 'BTC_USDT' },
      ],
    },
    {
      id: 'pepe',
      symbol: 'PEPE',
      name: 'Pepe',
      rank: 2,
      marketCapRank: 30,
      marketCapUsd: null,
      priceUsd: null,
      instruments: [{ exchange: 'bybit', symbol: '1000PEPEUSDT' }],
    },
  ],
});

const spot = (id: string, symbol: string) => ({ id, symbol, name: id, priceUsd: 1 }) as CoinSpotStats;

describe('buildOverviewResponse', () => {
  const stored: StoredMarketOverview = {
    // "PEPE" on CoinGecko is matched by id, so a different coin with the same ticker is ignored.
    coins: { data: [spot('bitcoin', 'BTC'), spot('other-pepe', 'PEPE')], fetchedAt: 100_000 },
    coinsError: null,
    global: { data: { btcDominancePct: 57 } as never, fetchedAt: 100_000 },
    globalError: null,
    refreshMs: 120_000,
  };

  it('joins CoinGecko figures to the universe by id, in rank order', () => {
    const r = buildOverviewResponse(stored, universe(), 110_000);
    expect(r.coins.map((c) => [c.asset, c.rank, c.spot?.id ?? null])).toEqual([
      ['BTC', 1, 'bitcoin'],
      ['PEPE', 2, null],
    ]);
    expect(r.notes).toEqual(['CoinGecko returned no figures for PEPE.']);
    expect(r.global).toEqual({ btcDominancePct: 57 });
    expect(r.coinsStale).toBe(false);
    expect(r.staleAfterMs).toBe(120_000 * OVERVIEW_STALE_POLLS);
  });

  it('labels figures stale after missed polls, and keeps them with their time', () => {
    const r = buildOverviewResponse(stored, universe(), 100_000 + 120_000 * OVERVIEW_STALE_POLLS + 1);
    expect(r.coinsStale).toBe(true);
    expect(r.globalStale).toBe(true);
    expect(r.coinsFetchedAt).toBe(100_000);
    expect(r.coins[0]?.spot?.id).toBe('bitcoin');
  });

  it('explains failed requests and still shows the previous figures', () => {
    const r = buildOverviewResponse(
      { ...stored, globalError: { message: 'HTTP 429', at: 200_000 } },
      universe(),
      200_000,
    );
    expect(r.notes).toContain(
      'The last CoinGecko request for global market figures failed (HTTP 429); showing the previous figures.',
    );
    expect(r.global).not.toBeNull();
  });

  it('does not match CoinGecko figures to a volume-ranked universe', () => {
    const r = buildOverviewResponse(stored, universe('volume'), 110_000);
    expect(r.coins.every((c) => c.spot === null)).toBe(true);
    expect(r.notes[0]).toMatch(/ranked by perpetual turnover/);
  });

  it('says why the page is empty before the collector has data', () => {
    const r = buildOverviewResponse(null, null, 1);
    expect(r.coins).toEqual([]);
    expect(r.global).toBeNull();
    expect(r.coinsStale).toBe(false);
    expect(r.notes).toHaveLength(2);
  });
});

function fields(values: Partial<Record<MarketField, number>>): Record<MarketField, Field<number>> {
  return Object.fromEntries(
    MARKET_FIELDS.map((f) => [
      f,
      values[f] === undefined ? unavailable('not_provided') : { available: true, value: values[f], ts: 1 },
    ]),
  ) as Record<MarketField, Field<number>>;
}

const inst = (exchange: InstrumentInfo['exchange'], symbol: string, multiplier = 1) =>
  ({ exchange, symbol, multiplier }) as InstrumentInfo;

const instruments: StoredInstruments = {
  ts: 1,
  capabilities: {},
  instruments: {
    bybit: [inst('bybit', 'BTCUSDT'), inst('bybit', '1000PEPEUSDT', 1000)],
    hyperliquid: [inst('hyperliquid', 'BTC')],
    gate: [inst('gate', 'BTC_USDT')],
  },
};

describe('buildPerpOverview', () => {
  const now = 1_000_000;
  const snapshots: ExchangeMarketSnapshot[] = [
    {
      exchange: 'bybit',
      ts: now - 1_000,
      rows: [
        {
          symbol: 'BTCUSDT',
          fields: fields({
            mark: 60_100,
            index: 60_000,
            fundingRate: 0.0001,
            fundingIntervalHours: 8,
            openInterest: 50_000,
            turnover24h: 5e9,
          }),
        },
        {
          symbol: '1000PEPEUSDT',
          fields: fields({ mark: 0.01, openInterest: 2_200, fundingRate: 0.0002, fundingIntervalHours: 4 }),
        },
      ],
    },
    {
      exchange: 'hyperliquid',
      ts: now - 1_000,
      rows: [
        {
          symbol: 'BTC',
          fields: fields({
            mark: 59_940,
            index: 60_000,
            fundingRate: -0.00001,
            fundingIntervalHours: 1,
            openInterest: 20_000,
            turnover24h: 1e9,
          }),
        },
      ],
    },
    // Collector stopped publishing Gate: its values must not count.
    {
      exchange: 'gate',
      ts: now - 60_000,
      rows: [{ symbol: 'BTC_USDT', fields: fields({ mark: 1, index: 1, openInterest: 1e12 }) }],
    },
  ];
  const baseline = {
    at: now - 86_400_000,
    oi: new Map([
      ['bybit:BTCUSDT', 40_000],
      ['hyperliquid:BTC', 20_000],
      ['bybit:1000PEPEUSDT', 2_000],
    ]),
  };

  it('summarises each universe asset across fresh exchanges only', () => {
    const r = buildPerpOverview(snapshots, instruments, universe(), baseline, now);
    expect(r.staleExchanges).toEqual(['gate']);
    const btc = r.assets[0]!;
    expect(btc.asset).toBe('BTC');
    expect(btc.venues).toEqual(['bybit', 'hyperliquid']);
    // Premiums +0.1667 % and −0.1 %: the median of two is their mean.
    expect(btc.premiumPct).toBeCloseTo((100 / 600 - 0.1) / 2, 6);
    // 0.03 %/24h and −0.024 %/24h.
    expect(btc.fundingLow).toEqual({ exchange: 'hyperliquid', rate24hPct: expect.closeTo(-0.024, 9) });
    expect(btc.fundingHigh).toEqual({ exchange: 'bybit', rate24hPct: expect.closeTo(0.03, 9) });
    expect(btc.openInterestUsd).toBeCloseTo(50_000 * 60_100 + 20_000 * 59_940, 0);
    expect(btc.oiVenues).toEqual(['bybit', 'hyperliquid']);
    // 70,000 BTC now vs 60,000 a day ago.
    expect(btc.oiChange24hPct).toBeCloseTo(16.6667, 3);
    expect(btc.turnover24hUsd).toBe(6e9);
  });

  it('uses the multiplier for the OI change of a 1000-prefixed contract', () => {
    const pepe = buildPerpOverview(snapshots, instruments, universe(), baseline, now).assets[1]!;
    expect(pepe.oiChange24hPct).toBeCloseTo(10, 9);
    expect(pepe.openInterestUsd).toBeCloseTo(22, 9);
    expect(pepe.premiumPct).toBeNull(); // no index published
    expect(pepe.fundingLow).toBeNull(); // one exchange only
  });

  it('adds up totals and reports a missing OI history as null', () => {
    const r = buildPerpOverview(snapshots, instruments, universe(), { at: null, oi: new Map() }, now);
    expect(r.assets[0]?.oiChange24hPct).toBeNull();
    expect(r.oiBaselineAt).toBeNull();
    expect(r.totals.turnover24hUsd).toBe(6e9);
    expect(r.totals.openInterestUsd).toBeCloseTo(50_000 * 60_100 + 20_000 * 59_940 + 22, 0);
  });

  it('returns no assets without a universe', () => {
    expect(buildPerpOverview(snapshots, instruments, null, baseline, now).assets).toEqual([]);
  });
});

describe('pickBaseline', () => {
  it('takes each instrument’s snapshot nearest the target within the tolerance', () => {
    const t = 10_000_000;
    const rows = [
      { ts: t - 120_000, exchange: 'bybit', symbol: 'BTCUSDT', openInterest: 1 },
      { ts: t - 60_000, exchange: 'bybit', symbol: 'BTCUSDT', openInterest: 2 },
      { ts: t + 120_000, exchange: 'bybit', symbol: 'BTCUSDT', openInterest: 3 },
      { ts: t - 60_000, exchange: 'gate', symbol: 'BTC_USDT', openInterest: null },
      { ts: t + 900_000, exchange: 'mexc', symbol: 'BTC_USDT', openInterest: 9 },
    ];
    const b = pickBaseline(rows, t, 600_000);
    expect([...b.oi]).toEqual([['bybit:BTCUSDT', 2]]);
    expect(b.at).toBe(t - 60_000);
  });
});
