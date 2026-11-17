import { describe, expect, it } from 'vitest';
import type { StoredInstruments } from '@mip/bus';
import {
  available,
  unavailable,
  type ExchangeMarketSnapshot,
  type InstrumentInfo,
  type MarketField,
  type MarketRow,
  type UniverseInfo,
} from '@mip/core';
import { assetInstruments, buildAssetRows, isAssetCode, sampleHistory } from './assets.js';

const NOW = 1_700_000_000_000;

function row(symbol: string, mark: number): MarketRow {
  const fields = {} as Record<MarketField, ReturnType<typeof available<number>>>;
  for (const f of ['last', 'mark', 'index', 'bid', 'ask', 'bidSize', 'askSize'] as const)
    fields[f] = available(mark, NOW - 500);
  return {
    symbol,
    fields: {
      ...fields,
      openInterest: unavailable('not_received'),
      fundingRate: unavailable('not_received'),
      fundingIntervalHours: unavailable('not_received'),
      nextFundingTime: unavailable('not_received'),
      turnover24h: unavailable('not_received'),
    },
  };
}

const instrument = (exchange: InstrumentInfo['exchange'], symbol: string, asset: string): InstrumentInfo => ({
  exchange,
  symbol,
  base: asset,
  asset,
  multiplier: 1,
  quote: 'USDT',
  contractSize: 1,
  tickSize: null,
  maxLeverage: unavailable('not_provided'),
  indexKind: 'index',
  launchTime: null,
  url: `https://example.com/${symbol}`,
});

const instruments: StoredInstruments = {
  instruments: {
    bybit: [instrument('bybit', 'BTCUSDT', 'BTC'), instrument('bybit', 'ETHUSDT', 'ETH')],
    gate: [instrument('gate', 'BTC_USDT', 'BTC')],
  },
  capabilities: {},
} as unknown as StoredInstruments;

const universe: UniverseInfo = {
  source: 'volume',
  builtAt: NOW,
  size: 1,
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
        { exchange: 'gate', symbol: 'BTC_USDT' },
      ],
    },
  ],
  problems: [],
  warnings: [],
};

const snap = (exchange: ExchangeMarketSnapshot['exchange'], ts: number, rows: MarketRow[]) => ({
  exchange,
  ts,
  rows,
});

describe('coin details', () => {
  it('uses the universe mapping, and falls back to instrument metadata outside the universe', () => {
    expect(assetInstruments('BTC', instruments, universe)).toEqual(universe.assets[0]!.instruments);
    expect(assetInstruments('ETH', instruments, universe)).toEqual([
      { exchange: 'bybit', symbol: 'ETHUSDT' },
    ]);
    expect(assetInstruments('DOGE', instruments, universe)).toEqual([]);
  });

  it('collects the asset on every exchange and marks old snapshots stale', () => {
    const out = buildAssetRows(
      'BTC',
      [
        snap('gate', NOW - 60_000, [row('BTC_USDT', 100)]), // collector stopped publishing Gate
        snap('bybit', NOW - 200, [row('BTCUSDT', 101), row('ETHUSDT', 5)]),
      ],
      instruments,
      universe,
      NOW,
    );
    expect(out.rows.map((r) => `${r.exchange}:${r.symbol}`)).toEqual(['bybit:BTCUSDT', 'gate:BTC_USDT']);
    expect(out.staleExchanges).toEqual(['gate']);
    expect(out.rows[0]!.fields.mark).toMatchObject({ available: true, value: 101 });
    expect(out.rows[1]!.fields.mark).toMatchObject({ available: false, reason: 'stale' });
    expect(out.rows[0]).toMatchObject({ assetId: 'bitcoin', assetRank: 1 });
    expect(out.rows[0]!.instrument?.url).toBe('https://example.com/BTCUSDT');
    expect(out.universe?.name).toBe('Bitcoin');
  });

  it('samples minute history on clock-aligned steps', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0);
    const points = Array.from({ length: 61 }, (_, i) => ({ ts: base + i * 60_000 }));
    expect(sampleHistory(points, 15).map((p) => (p.ts - base) / 60_000)).toEqual([0, 15, 30, 45, 60]);
  });

  it('validates asset codes', () => {
    for (const ok of ['BTC', '1000PEPE', 'kPEPE', 'BTC.D']) expect(isAssetCode(ok), ok).toBe(true);
    for (const bad of ['', 'a b', '../x', 'x'.repeat(31), '<b>']) expect(isAssetCode(bad), bad).toBe(false);
  });
});
