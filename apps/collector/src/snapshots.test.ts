import { describe, expect, it } from 'vitest';
import {
  available,
  MARKET_FIELDS,
  unavailable,
  type ExchangeMarketSnapshot,
  type Field,
  type MarketField,
} from '@mip/core';
import { snapshotRows } from './snapshots.js';

function fields(values: Partial<Record<MarketField, number>>): Record<MarketField, Field<number>> {
  return Object.fromEntries(
    MARKET_FIELDS.map((f) => [f, values[f] === undefined ? unavailable('stale') : available(values[f]!, 1)]),
  ) as Record<MarketField, Field<number>>;
}

describe('snapshotRows', () => {
  it('stores fresh values only and skips instruments with nothing fresh', () => {
    const snap: ExchangeMarketSnapshot = {
      exchange: 'bybit',
      ts: 1,
      rows: [
        {
          symbol: 'A',
          fields: fields({
            mark: 10,
            openInterest: 5,
            nextFundingTime: 1_800_000_000_000,
            fundingIntervalHours: 8,
          }),
        },
        { symbol: 'B', fields: fields({ bid: 1 }) },
      ],
    };
    const rows = snapshotRows([snap], 1_800_000_000_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      ts: new Date(1_800_000_000_000),
      exchange: 'bybit',
      symbol: 'A',
      mark: 10,
      last: null,
      openInterest: 5,
      fundingRate: null,
      fundingInterval: 8,
      nextFundingTime: new Date(1_800_000_000_000),
      turnover24h: null,
    });
  });
});
