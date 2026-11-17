import { describe, expect, it } from 'vitest';
import { createLogger, EXCHANGE_IDS, type ExchangeId } from '@mip/core';
import { pauseSharedLimiter } from '../base/rate-limiter.js';
import { loadFixture } from '../test-support/replay.js';
import { DepthFetcher, parseOrderBook } from './index.js';

// Order books recorded from each exchange's REST API (ETH, 2026-11-17), trimmed to 5 levels.
const contractSize: Partial<Record<ExchangeId, number>> = { mexc: 0.01, gate: 0.01 };

describe('order book parsing (recorded payloads)', () => {
  for (const ex of EXCHANGE_IDS) {
    it(`${ex}: best bid below best ask, sizes in base units, levels sorted`, () => {
      const book = parseOrderBook(ex, 'ETH', loadFixture(import.meta.url, ex), contractSize[ex] ?? 1, 1);
      expect(book.bids.length).toBeGreaterThanOrEqual(5);
      expect(book.asks.length).toBeGreaterThanOrEqual(5);
      expect(book.bids[0]![0]).toBeLessThan(book.asks[0]![0]);
      expect(book.bids[0]![0]).toBeGreaterThan(1000); // ETH around 1,820 when recorded
      for (let i = 1; i < 5; i++) {
        expect(book.bids[i]![0]).toBeLessThan(book.bids[i - 1]![0]);
        expect(book.asks[i]![0]).toBeGreaterThan(book.asks[i - 1]![0]);
      }
      expect(book.ts).toBeGreaterThan(1_700_000_000_000);
    });
  }

  it('multiplies contract sizes on MEXC and Gate', () => {
    const mexc = parseOrderBook('mexc', 'ETH_USDT', loadFixture(import.meta.url, 'mexc'), 0.01, 1);
    expect(mexc.asks[0]).toEqual([1820.72, 94706 * 0.01]);
    const gate = parseOrderBook('gate', 'ETH_USDT', loadFixture(import.meta.url, 'gate'), 0.01, 1);
    expect(gate.asks[0]![1]).toBeCloseTo(6804.7 * 0.01, 9); // fractional contracts thanks to X-Gate-Size-Decimal
  });

  it('returns empty sides for malformed bodies instead of throwing', () => {
    expect(parseOrderBook('bybit', 'X', { retCode: 0 }, 1, 5)).toEqual({
      exchange: 'bybit',
      symbol: 'X',
      bids: [],
      asks: [],
      ts: 5,
    });
  });
});

describe('DepthFetcher', () => {
  it('fails at once while the exchange is paused instead of waiting for the ban to end', async () => {
    pauseSharedLimiter('gate/rest', Date.now() + 60 * 60_000);
    const fetcher = new DepthFetcher(createLogger({ service: 'test', level: 'silent' }));
    const started = Date.now();
    await expect(fetcher.fetch('gate', 'BTC_USDT', 0.0001)).rejects.toThrow(/paused until/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetcher.pausedUntil('gate')).toBeGreaterThan(Date.now());
  });
});
