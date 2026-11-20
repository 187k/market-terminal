import { describe, expect, it } from 'vitest';
import type { StoredInstruments } from '@mip/bus';
import type { OrderBook } from '@mip/connectors';
import {
  available,
  MARKET_FIELDS,
  unavailable,
  type Candle,
  type ExchangeMarketSnapshot,
  type Field,
  type InstrumentInfo,
  type MarketField,
  type TradeEvent,
} from '@mip/core';
import { createTerminalSource, toTerminalBook, type TerminalDeps } from './terminal.js';

const T0 = 1_795_183_230_000; // 21:20:30 UTC, inside the 21:20 one-minute candle

const instrument: InstrumentInfo = {
  exchange: 'bybit',
  symbol: 'ETHUSDT',
  base: 'ETH',
  asset: 'ETH',
  multiplier: 1,
  quote: 'USDT',
  contractSize: 1,
  tickSize: 0.01,
  maxLeverage: unavailable('not_provided'),
  indexKind: 'index',
  launchTime: null,
  url: 'https://www.bybit.com/trade/usdt/ETHUSDT',
};

const fields = (last: number, ts: number): Record<MarketField, Field<number>> => {
  const out = {} as Record<MarketField, Field<number>>;
  for (const f of MARKET_FIELDS) out[f] = unavailable('not_received');
  out.last = available(last, ts);
  out.mark = available(last + 0.5, ts);
  return out;
};

const candle = (openTime: number, close: number): Candle => ({
  openTime,
  open: 1750,
  high: 1752,
  low: 1749,
  close,
  volume: 10,
  turnover: 17_500,
});

function setup(over: Partial<TerminalDeps> = {}) {
  let now = T0;
  const calls: string[] = [];
  const minute = Math.floor(T0 / 60_000) * 60_000;
  const snapshot: ExchangeMarketSnapshot = {
    exchange: 'bybit',
    ts: T0 - 500,
    rows: [{ symbol: 'ETHUSDT', fields: fields(1755, T0 - 600) }],
  };
  const book: OrderBook = {
    exchange: 'bybit',
    symbol: 'ETHUSDT',
    bids: [
      [1754.9, 2],
      [1754.8, 1],
    ],
    asks: [
      [1755.1, 3],
      [1755.2, 1],
    ],
    ts: T0 - 100,
  };
  const trades: TradeEvent[] = [
    { exchange: 'bybit', symbol: 'ETHUSDT', ts: T0 - 2_000, price: 1754, size: 1, side: 'buy' },
    { exchange: 'bybit', symbol: 'ETHUSDT', ts: T0 - 1_000, price: 1755, size: 2, side: 'sell' },
  ];
  const deps: TerminalDeps = {
    snapshot: async () => snapshot,
    instruments: async () =>
      ({ ts: 0, instruments: { bybit: [instrument] }, capabilities: {} }) satisfies StoredInstruments,
    klines: {
      fetch: async (_ex, _sym, interval, q) => {
        calls.push(`klines:${interval}:${q.limit}`);
        if (interval === '1h') return [candle(minute - 3_600_000, 1700), candle(minute, 1760)];
        return [candle(minute - 120_000, 1751), candle(minute - 60_000, 1752), candle(minute, 1753)];
      },
    },
    depth: {
      fetch: async () => {
        calls.push('depth');
        return book;
      },
    },
    trades: { get: () => trades },
    tradesSince: () => T0 - 3_600_000,
    tradesMinNotional: 500,
    bookRefreshMs: 2_000,
    candleSyncMs: 10_000,
    now: () => now,
    ...over,
  };
  return {
    source: createTerminalSource(deps),
    calls,
    snapshot,
    minute,
    advance: (ms: number) => (now += ms),
  };
}

describe('terminal source', () => {
  it('combines live values, candles, the 24 h summary, the book and trades', async () => {
    const { source, minute } = setup();
    const r = await source.live('bybit', 'ETHUSDT', '1m');
    expect(r.instrument).toEqual(instrument);
    expect(r.fields?.last).toEqual(available(1755, T0 - 600));
    // The forming candle follows the live last price; closed ones are the exchange's.
    expect(r.candles.map((c) => c.close)).toEqual([1751, 1752, 1755]);
    expect(r.candles.at(-1)).toMatchObject({ openTime: minute, high: 1755, volume: 10 });
    expect(r.candlesSyncedAt).toBe(T0);
    expect(r.stats24h).toEqual({
      open: 1750,
      high: 1755,
      low: 1749,
      volume: 20,
      turnover: 35_000,
      changePct: ((1755 - 1750) / 1750) * 100,
      hours: 2,
    });
    expect(r.book?.bids[0]).toEqual([1754.9, 2]);
    expect(r.book?.spreadPct).toBeCloseTo((0.2 / 1754.9) * 100, 10);
    expect(r.trades.map((t) => t.price)).toEqual([1755, 1754]); // newest first
    expect(r.tradesMinNotional).toBe(500);
    expect(r.candlesError ?? r.bookError ?? r.statsError).toBeNull();
  });

  it('asks the exchange again only when a refresh is due', async () => {
    const { source, calls, advance } = setup();
    await source.live('bybit', 'ETHUSDT', '1m');
    expect(calls).toEqual(['klines:1m:3', 'klines:1h:24', 'depth']);
    calls.length = 0;
    advance(1_000);
    await source.live('bybit', 'ETHUSDT', '1m');
    expect(calls).toEqual([]);
    advance(1_000); // 2 s: book refresh due
    await source.live('bybit', 'ETHUSDT', '1m');
    expect(calls).toEqual(['depth']);
  });

  it('re-syncs candles right after the forming candle’s period ends', async () => {
    const { source, calls, advance } = setup({ candleSyncMs: 120_000 });
    await source.live('bybit', 'ETHUSDT', '1m');
    calls.length = 0;
    advance(29_000); // 21:20:59: same minute, nothing due
    await source.live('bybit', 'ETHUSDT', '1m');
    expect(calls).not.toContain('klines:1m:3');
    advance(2_000); // 21:21:01: the minute is over
    await source.live('bybit', 'ETHUSDT', '1m');
    expect(calls).toContain('klines:1m:3');
  });

  it('does not show a book whose refresh failed, and does not retry it on every read', async () => {
    let attempts = 0;
    const { source, advance } = setup({
      depth: {
        fetch: async () => {
          attempts++;
          throw new Error('bybit REST requests paused until 2026-11-20T22:00:00.000Z (rate limit or ban)');
        },
      },
    });
    const r = await source.live('bybit', 'ETHUSDT', '5m');
    expect(r.book).toBeNull();
    expect(r.bookError).toMatch(/paused until/);
    expect(r.candles).toHaveLength(3); // other parts are unaffected
    advance(500);
    await source.live('bybit', 'ETHUSDT', '5m');
    expect(attempts).toBe(1);
  });

  it('does not move candles with a stale last price', async () => {
    const { source, snapshot } = setup();
    snapshot.ts = T0 - 60_000; // collector stopped publishing
    const r = await source.live('bybit', 'ETHUSDT', '1m');
    expect(r.stale).toBe(true);
    expect(r.fields?.last.available).toBe(false);
    expect(r.candles.at(-1)!.close).toBe(1753);
    expect(r.stats24h?.changePct).toBeCloseTo(((1760 - 1750) / 1750) * 100, 10);
  });

  it('reports an untracked instrument without asking the exchange', async () => {
    const { source, calls } = setup();
    const r = await source.live('bybit', 'DOGEUSDT', '1m');
    expect(r.instrument).toBeNull();
    expect(r.fields).toBeNull();
    expect(r.candlesError).toMatch(/not tracked/);
    expect(calls).toEqual([]);
    expect(await source.candles('bybit', 'DOGEUSDT', '1m', { limit: 10 })).toBeNull();
  });

  it('flags Hyperliquid TWAP slices in the trade list', async () => {
    const { source } = setup({
      trades: {
        get: () => [
          {
            exchange: 'hyperliquid',
            symbol: 'ETH',
            ts: T0,
            price: 1755,
            size: 1,
            side: 'buy',
            hash: '0x' + '0'.repeat(64),
          },
        ],
      },
    });
    const r = await source.live('bybit', 'ETHUSDT', '1m');
    expect(r.trades[0]).toEqual({ ts: T0, price: 1755, size: 1, side: 'buy', twapSlice: true });
  });
});

describe('toTerminalBook', () => {
  it('keeps the best levels and reports an empty side as no spread', () => {
    const b = toTerminalBook({ exchange: 'gate', symbol: 'X', bids: [[1, 1]], asks: [], ts: 5 }, 1);
    expect(b).toEqual({ bids: [[1, 1]], asks: [], ts: 5, spreadPct: null });
  });
});
