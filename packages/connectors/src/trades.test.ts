import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TradeEvent } from '@mip/core';
import { parseAggTrade } from './binance/parse.js';
import { parseTrades as bingxTrades } from './bingx/parse.js';
import { parseTrades as bitgetTrades } from './bitget/parse.js';
import { parseTrades as bybitTrades } from './bybit/parse.js';
import { parseTrades as gateTrades } from './gate/parse.js';
import { isZeroHash, parseTrades as hlTrades } from './hyperliquid/parse.js';
import { parseDeals } from './mexc/parse.js';

// Trade messages recorded live with tools/record-trades.mjs (BTC and ETH, 2026-11-17).
const fx = (exchange: string, file = 'ws-trades') =>
  JSON.parse(readFileSync(new URL(`./${exchange}/fixtures/${file}.json`, import.meta.url), 'utf8')) as Record<
    string,
    any[]
  >;

function sane(trades: TradeEvent[], exchange: string) {
  expect(trades.length).toBeGreaterThan(0);
  for (const t of trades) {
    expect(t.exchange).toBe(exchange);
    expect(['buy', 'sell']).toContain(t.side);
    expect(t.size).toBeGreaterThan(0);
    // BTC around 64k, ETH around 1.8k when recorded
    expect(t.price > 1_000 && t.price < 100_000).toBe(true);
    expect(t.ts).toBeGreaterThan(1_790_000_000_000);
  }
}

describe('trade parsing (recorded payloads)', () => {
  it('Bybit publicTrade: taker side from S, size in base units', () => {
    const msg = fx('bybit')['publicTrade:snapshot']![0];
    const trades = bybitTrades(msg.data);
    sane(trades, 'bybit');
    expect(trades[0]).toMatchObject({
      side: msg.data[0].S === 'Buy' ? 'buy' : 'sell',
      size: Number(msg.data[0].v),
    });
  });

  it('Binance aggTrade: m = buyer was maker → taker sold', () => {
    const d = fx('binance').aggTrade![0].data;
    const t = parseAggTrade(d)!;
    sane([t], 'binance');
    expect(t.side).toBe(d.m ? 'sell' : 'buy');
    expect(parseAggTrade({ e: 'markPriceUpdate', s: 'X' })).toBeNull();
  });

  it('MEXC push.deal: T 1/2 = buy/sell, contracts × contract size', () => {
    const msg = fx('mexc')['push.deal']![0];
    const trades = parseDeals(msg.symbol, msg.data, 0.0001);
    sane(trades, 'mexc');
    expect(trades[0]!.size).toBeCloseTo(msg.data[0].v * 0.0001, 12);
    expect(trades[0]!.side).toBe(msg.data[0].T === 1 ? 'buy' : 'sell');
  });

  it('Bitget trade update: side is the taker side', () => {
    const msg = fx('bitget')['trade:update']![0];
    sane(bitgetTrades(msg.arg.instId, msg.data), 'bitget');
  });

  it('BingX trade: Binance-style maker flag', () => {
    const msg = fx('bingx').trade![0];
    const trades = bingxTrades(msg.data);
    sane(trades, 'bingx');
    expect(trades[0]!.side).toBe(msg.data[0].m ? 'sell' : 'buy');
  });

  it('Gate futures.trades: sign of size = taker side, contracts × multiplier', () => {
    const msg = fx('gate')['futures.trades:update']![0];
    const trades = gateTrades(msg.result, (s) =>
      s === 'BTC_USDT' ? 0.0001 : s === 'ETH_USDT' ? 0.01 : undefined,
    );
    sane(trades, 'gate');
    expect(trades[0]!.size).toBeCloseTo(Math.abs(msg.result[0].size) * 0.0001, 12);
    expect(trades[0]!.side).toBe(msg.result[0].size > 0 ? 'buy' : 'sell');
  });

  it('Hyperliquid trades keep both wallets and the hash; zero hash marks TWAP slices', () => {
    const batch = fx('hyperliquid', 'ws-0').trades![0].data;
    const trades = hlTrades(batch);
    sane(trades, 'hyperliquid');
    expect(trades[0]!.users).toEqual(batch[0].users);
    expect(trades[0]!.hash).toBe(batch[0].hash);
    expect(isZeroHash('0x' + '0'.repeat(64))).toBe(true);
    expect(isZeroHash(batch[0].hash)).toBe(false);
    expect(isZeroHash(undefined)).toBe(false);
  });
});
