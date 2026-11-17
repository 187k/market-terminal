import { describe, expect, it } from 'vitest';
import {
  MARKET_FIELDS,
  type ExchangeMarketSnapshot,
  type Field,
  type MarketField,
  type UniverseInfo,
} from '@mip/core';
import { buildMarketsResponse, SNAPSHOT_MAX_AGE_MS } from './markets.js';

function fields(value: number): Record<MarketField, Field<number>> {
  return Object.fromEntries(MARKET_FIELDS.map((f) => [f, { available: true, value, ts: 1 }])) as Record<
    MarketField,
    Field<number>
  >;
}

const snapshot: ExchangeMarketSnapshot = {
  exchange: 'bybit',
  ts: 10_000,
  rows: [
    { symbol: 'ETHUSDT', fields: fields(2) },
    { symbol: 'BTCUSDT', fields: fields(1) },
    { symbol: 'ZZZUSDT', fields: fields(3) },
  ],
};

const universe: UniverseInfo = {
  source: 'coingecko',
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
      marketCapUsd: 1,
      priceUsd: 1,
      instruments: [{ exchange: 'bybit', symbol: 'BTCUSDT' }],
    },
    {
      id: 'ethereum',
      symbol: 'ETH',
      name: 'Ethereum',
      rank: 2,
      marketCapRank: 2,
      marketCapUsd: 1,
      priceUsd: 1,
      instruments: [{ exchange: 'bybit', symbol: 'ETHUSDT' }],
    },
  ],
};

describe('buildMarketsResponse', () => {
  it('orders rows by universe rank and attaches asset ids', () => {
    const res = buildMarketsResponse('bybit', snapshot, null, universe, 10_500);
    expect(res.rows.map((r) => `${r.assetRank}:${r.symbol}`)).toEqual([
      '1:BTCUSDT',
      '2:ETHUSDT',
      'null:ZZZUSDT',
    ]);
    expect(res.rows[0]!.assetId).toBe('bitcoin');
    expect(res.stale).toBe(false);
    expect(res.rows[0]!.fields.mark).toMatchObject({ available: true, value: 1 });
  });

  it('reports every value as stale when the collector stopped publishing', () => {
    const res = buildMarketsResponse('bybit', snapshot, null, universe, 10_000 + SNAPSHOT_MAX_AGE_MS + 1);
    expect(res.stale).toBe(true);
    expect(res.rows[0]!.fields.mark).toEqual({
      available: false,
      reason: 'stale',
      detail: 'collector stopped publishing',
    });
  });

  it('handles an exchange with nothing published', () => {
    expect(buildMarketsResponse('gate', null, null, null, 1)).toEqual({
      exchange: 'gate',
      ts: null,
      stale: false,
      rows: [],
      capabilities: null,
    });
  });
});
