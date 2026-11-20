import { afterEach, describe, expect, it } from 'vitest';
import { EXCHANGE_IDS, type ExchangeId } from '@mip/core';
import { pauseSharedLimiter } from '../base/rate-limiter.js';
import { loadFixture } from '../test-support/replay.js';
import { json, silentLogger, startHttpServer, type TestHttpServer } from '../test-support/servers.js';
import { KlineFetcher, klineInterval, klineRequest, parseKlines } from './index.js';

// ETH 5-minute candles recorded from each exchange's public REST API (2026-11-20, ETH ≈ 1,750).
const contractSize: Partial<Record<ExchangeId, number>> = { mexc: 0.01, gate: 0.01 };
const parse = (ex: ExchangeId, extra: { limit?: number; before?: number } = {}) =>
  parseKlines(ex, loadFixture(import.meta.url, ex), {
    limit: extra.limit ?? 500,
    contractSize: contractSize[ex] ?? 1,
    ...(extra.before !== undefined ? { before: extra.before } : {}),
  });

describe('kline parsing (recorded payloads)', () => {
  for (const ex of EXCHANGE_IDS) {
    it(`${ex}: oldest first, 5-minute steps, plausible OHLC`, () => {
      const candles = parse(ex);
      expect(candles.length).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        expect(c.openTime % 300_000).toBe(0);
        if (i > 0) expect(c.openTime - candles[i - 1]!.openTime).toBe(300_000);
        expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
        expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
        expect(c.close).toBeGreaterThan(1_500);
        expect(c.close).toBeLessThan(2_000);
        expect(c.volume).toBeGreaterThan(0);
      }
    });
  }

  it('converts contract volume to base units on MEXC and Gate', () => {
    const mexc = parse('mexc')[0]!;
    const raw = loadFixture(import.meta.url, 'mexc').data;
    expect(mexc.openTime).toBe(raw.time[0] * 1000);
    expect(mexc.volume).toBeCloseTo(raw.vol[0] * 0.01, 6);
    expect(mexc.turnover).toBe(raw.amount[0]);
    const gate = parse('gate')[0]!;
    const g = loadFixture(import.meta.url, 'gate')[0];
    expect(gate.volume).toBeCloseTo(Number(g.v) * 0.01, 6);
    expect(gate.turnover).toBe(Number(g.sum));
    // Turnover / volume is a price inside the candle's range.
    expect(gate.turnover! / gate.volume).toBeGreaterThan(gate.low * 0.99);
    expect(gate.turnover! / gate.volume).toBeLessThan(gate.high * 1.01);
  });

  it('reports turnover only where the exchange gives it', () => {
    for (const ex of ['hyperliquid', 'bingx'] as const) expect(parse(ex)[0]!.turnover).toBeNull();
    for (const ex of ['bybit', 'binance', 'mexc', 'bitget', 'gate'] as const) {
      const c = parse(ex)[0]!;
      expect(c.turnover! / c.volume).toBeGreaterThan(c.low * 0.99);
      expect(c.turnover! / c.volume).toBeLessThan(c.high * 1.01);
    }
  });

  it('sorts newest-first payloads (Bybit, BingX) into oldest first', () => {
    const raw = loadFixture(import.meta.url, 'bybit').result.list;
    expect(Number(raw[0][0])).toBeGreaterThan(Number(raw[1][0]));
    const candles = parse('bybit');
    expect(candles.at(-1)!.openTime).toBe(Number(raw[0][0]));
  });

  it('keeps only candles before `before`, newest `limit` of them', () => {
    const all = parse('binance');
    const cut = all[3]!.openTime;
    const older = parse('binance', { before: cut });
    expect(older.every((c) => c.openTime < cut)).toBe(true);
    expect(older).toHaveLength(3);
    expect(parse('binance', { limit: 2 })).toEqual(all.slice(-2));
  });

  it('drops implausible rows and survives malformed bodies', () => {
    const body = {
      result: {
        list: [
          ['1795183200000', '10', '9', '11', '10', '1', '10'], // high below low
          ['1795182900000', '0', '1', '1', '1', '1', '1'], // zero open
          ['1795182600000', '10', '12', '9', '11', '1', '10'],
        ],
      },
    };
    expect(parseKlines('bybit', body, { limit: 10, contractSize: 1 })).toHaveLength(1);
    for (const ex of EXCHANGE_IDS)
      expect(parseKlines(ex, { nonsense: true }, { limit: 10, contractSize: 1 })).toEqual([]);
  });
});

describe('kline requests', () => {
  const now = 1_795_183_456_789;

  it('maps intervals to each exchange’s names', () => {
    expect(klineInterval('bybit', '1h')).toBe('60');
    expect(klineInterval('mexc', '4h')).toBe('Hour4');
    expect(klineInterval('bitget', '1d')).toBe('1Dutc');
    expect(klineInterval('gate', '1w')).toBe('7d');
  });

  it('asks Binance for weight by page size and an inclusive end before `before`', () => {
    const r = klineRequest('binance', 'ETHUSDT', '5m', { limit: 300, before: 1_000_000 }, now);
    expect(r.query).toEqual({ symbol: 'ETHUSDT', interval: '5m', limit: 300, endTime: 999_999 });
    expect(r.weight).toBe(2);
    expect(klineRequest('binance', 'X', '5m', { limit: 50 }, now).weight).toBe(1);
  });

  it('caps the page size', () => {
    expect(klineRequest('bybit', 'X', '1m', { limit: 5_000 }, now).query?.limit).toBe(500);
  });

  it('uses a time range in seconds where the exchange needs one', () => {
    const mexc = klineRequest('mexc', 'ETH_USDT', '5m', { limit: 10 }, now);
    expect(mexc.query).toEqual({
      interval: 'Min5',
      start: Math.floor((now - 11 * 300_000) / 1000),
      end: Math.floor(now / 1000),
    });
    const gateLatest = klineRequest('gate', 'ETH_USDT', '1h', { limit: 10 }, now);
    expect(gateLatest.query).toEqual({ contract: 'ETH_USDT', interval: '1h', limit: 10 });
    // Gate rejects `limit` together with a range: 11 hours back from just before `before`.
    const before = 1_795_180_000_000;
    const gateOlder = klineRequest('gate', 'ETH_USDT', '1h', { limit: 10, before }, now);
    expect(gateOlder.query).toEqual({
      contract: 'ETH_USDT',
      interval: '1h',
      from: 1_795_140_399,
      to: 1_795_179_999,
    });
  });

  it('weighs Hyperliquid candle snapshots by the number of candles', () => {
    const r = klineRequest('hyperliquid', 'ETH', '1m', { limit: 300 }, now);
    expect(r.method).toBe('POST');
    expect(r.body).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'ETH', interval: '1m', startTime: now - 301 * 60_000, endTime: now },
    });
    expect(r.weight).toBe(25);
  });
});

describe('KlineFetcher', () => {
  let server: TestHttpServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('requests and parses one page from the exchange', async () => {
    server = await startHttpServer((_req, res) => json(res, 200, loadFixture(import.meta.url, 'bitget')));
    const fetcher = new KlineFetcher(silentLogger, { bitget: server.baseUrl });
    const candles = await fetcher.fetch('bitget', 'ETHUSDT', '5m', { limit: 3, contractSize: 1 });
    expect(candles).toHaveLength(3);
    const url = new URL(server.hits[0]!.path, 'http://x');
    expect(url.pathname).toBe('/api/v2/mix/market/candles');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'ETHUSDT',
      productType: 'USDT-FUTURES',
      granularity: '5m',
      limit: '3',
    });
  });

  it('fails at once while the exchange is paused instead of waiting for the ban to end', async () => {
    pauseSharedLimiter('bingx/rest', Date.now() + 60 * 60_000);
    const fetcher = new KlineFetcher(silentLogger);
    const started = Date.now();
    await expect(fetcher.fetch('bingx', 'ETH-USDT', '1m', { limit: 5, contractSize: 1 })).rejects.toThrow(
      /paused until/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetcher.pausedUntil('bingx')).toBeGreaterThan(Date.now());
  });
});
