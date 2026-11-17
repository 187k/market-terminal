import { describe, expect, it } from 'vitest';
import type { ExchangeCapabilities, MarketUpdate } from '@mip/core';
import { MarketState, validate } from './market-state.js';

const CHANGE = { source: 'ws', refresh: 'change', maxAgeMs: 60_000 } as const;
const caps: ExchangeCapabilities = {
  last: CHANGE,
  mark: { source: 'ws', refresh: 'interval', maxAgeMs: 10_000 },
  index: { source: 'none', note: 'no index on this venue' },
  bid: CHANGE,
  ask: CHANGE,
  bidSize: CHANGE,
  askSize: CHANGE,
  openInterest: { source: 'rest', refresh: 'interval', maxAgeMs: 120_000 },
  fundingRate: CHANGE,
  fundingIntervalHours: CHANGE,
  nextFundingTime: CHANGE,
  turnover24h: { source: 'none', reason: 'requires_api_key' },
};

function setup() {
  let now = 1_000_000;
  const state = new MarketState(() => now);
  state.register('bybit', caps);
  state.setTracked('bybit', ['BTCUSDT']);
  const apply = (values: MarketUpdate['values'], extra: Partial<MarketUpdate> = {}) =>
    state.apply('bybit', {
      symbol: 'BTCUSDT',
      values,
      exchangeTs: null,
      receivedAt: now,
      connection: 'ws#0',
      ...extra,
    });
  return {
    state,
    apply,
    tick: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}

describe('MarketState', () => {
  it('reports why a field is missing', () => {
    const { state } = setup();
    expect(state.field('bybit', 'BTCUSDT', 'last')).toEqual({ available: false, reason: 'not_received' });
    expect(state.field('bybit', 'BTCUSDT', 'index')).toEqual({
      available: false,
      reason: 'not_provided',
      detail: 'no index on this venue',
    });
    expect(state.field('bybit', 'BTCUSDT', 'turnover24h')).toMatchObject({ reason: 'requires_api_key' });
    expect(state.field('bybit', 'ETHUSDT', 'last')).toMatchObject({ reason: 'not_received' });
  });

  it('merges partial updates (snapshot + delta)', () => {
    const t = setup();
    t.apply({ last: 100, bid: 99, ask: 101 });
    t.tick(100);
    t.apply({ bid: 99.5 });
    expect(t.state.field('bybit', 'BTCUSDT', 'bid')).toMatchObject({ available: true, value: 99.5 });
    expect(t.state.field('bybit', 'BTCUSDT', 'ask')).toMatchObject({ available: true, value: 101 });
  });

  it('keeps change-only fields valid while the symbol keeps receiving messages', () => {
    const t = setup();
    t.apply({ last: 100 });
    for (let i = 0; i < 10; i++) {
      t.tick(30_000);
      t.apply({ bid: 99 + i }); // last price unchanged, but the stream is alive
    }
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toMatchObject({
      available: true,
      value: 100,
      ts: t.now,
    });
    t.tick(61_000);
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toEqual({
      available: false,
      reason: 'stale',
      detail: 'no update for 61 s',
    });
  });

  it('expires interval fields that are not refreshed', () => {
    const t = setup();
    t.apply({ mark: 100 });
    t.tick(9_000);
    t.apply({ bid: 1 });
    expect(t.state.field('bybit', 'BTCUSDT', 'mark').available).toBe(true);
    t.tick(2_000);
    t.apply({ bid: 1 });
    expect(t.state.field('bybit', 'BTCUSDT', 'mark')).toMatchObject({ reason: 'stale' });
  });

  it('marks values stale when their connection drops, until fresh data arrives', () => {
    const t = setup();
    t.apply({ last: 100 });
    t.apply({ openInterest: 5 }, { connection: null });
    t.tick(10);
    t.state.connectionDown('bybit', 'ws#0', t.now);
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toEqual({
      available: false,
      reason: 'stale',
      detail: 'connection interrupted',
    });
    expect(t.state.field('bybit', 'BTCUSDT', 'openInterest').available).toBe(true); // REST value unaffected
    t.tick(10);
    t.apply({ last: 101 });
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toMatchObject({ available: true, value: 101 });
  });

  it('drops out-of-order updates by exchange time', () => {
    const t = setup();
    t.apply({ last: 101 }, { exchangeTs: 2_000 });
    t.apply({ last: 100 }, { exchangeTs: 1_000 }); // older, e.g. from the overlapping socket during rotation
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toMatchObject({ value: 101 });
    t.apply({ last: 102 }, { exchangeTs: 3_000 });
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toMatchObject({ value: 102 });
  });

  it('accepts a WS snapshot stamped earlier than the REST bootstrap (different clocks of meaning)', () => {
    const t = setup();
    // REST response time 5_000; the WS snapshot says the value last changed at 4_000.
    t.apply({ mark: 100 }, { connection: null, exchangeTs: 5_000 });
    t.apply({ mark: 100.5 }, { exchangeTs: 4_000 });
    expect(t.state.field('bybit', 'BTCUSDT', 'mark')).toMatchObject({ value: 100.5 });
    // within one stream, order still matters
    t.apply({ mark: 99 }, { exchangeTs: 3_000 });
    expect(t.state.field('bybit', 'BTCUSDT', 'mark')).toMatchObject({ value: 100.5 });
  });

  it('judges change-only fields by their own connection, not by another busy one', () => {
    const t = setup();
    t.apply({ bid: 99 }, { connection: 'book#0' });
    for (let i = 0; i < 7; i++) {
      t.tick(10_000);
      t.apply({ mark: 100 + i }, { connection: 'mark#0' }); // a different, busy stream
    }
    // 70 s without a message on the book connection for this symbol: stale despite mark updates
    expect(t.state.field('bybit', 'BTCUSDT', 'bid')).toMatchObject({ available: false, reason: 'stale' });
  });

  it('does not let a REST re-sync take over a field a live stream maintains', () => {
    const t = setup();
    t.apply({ fundingIntervalHours: 8 }); // WS snapshot
    t.tick(15 * 60_000);
    t.apply({ bid: 1 }); // the stream stays alive
    t.apply({ fundingIntervalHours: 8 }, { connection: null }); // periodic REST re-sync
    t.tick(10 * 60_000);
    t.apply({ bid: 2 });
    // still valid: confirmed by the live stream, not aged as a REST value
    expect(t.state.field('bybit', 'BTCUSDT', 'fundingIntervalHours')).toMatchObject({
      available: true,
      value: 8,
    });
  });

  it('gives a REST snapshot of a stream field only a short life if the stream never delivers', () => {
    const t = setup();
    t.apply({ last: 100, openInterest: 5 }, { connection: null }); // bootstrap; stream down
    t.tick(20_000);
    expect(t.state.field('bybit', 'BTCUSDT', 'last').available).toBe(true);
    t.tick(15_000);
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toMatchObject({
      available: false,
      reason: 'stale',
      detail: 'only a REST snapshot from 35 s ago; the stream is not delivering',
    });
    // a REST-sourced field keeps its own limit (120 s here)
    expect(t.state.field('bybit', 'BTCUSDT', 'openInterest').available).toBe(true);
  });

  it('lets REST fill a field whose stream has dropped', () => {
    const t = setup();
    t.apply({ last: 100 });
    t.tick(10);
    t.state.connectionDown('bybit', 'ws#0', t.now);
    t.tick(10);
    t.apply({ last: 101 }, { connection: null });
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toMatchObject({ available: true, value: 101 });
  });

  it('rejects implausible values and reports them as invalid', () => {
    const t = setup();
    t.apply({ last: 100 });
    t.apply({ last: -5, fundingRate: 0.5 });
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toEqual({
      available: false,
      reason: 'invalid',
      detail: 'price must be > 0 (got -5)',
    });
    expect(t.state.field('bybit', 'BTCUSDT', 'fundingRate')).toMatchObject({ reason: 'invalid' });
    expect(t.state.dataHealth('bybit')!.invalid).toBe(2);
    t.apply({ last: 100.5 });
    expect(t.state.field('bybit', 'BTCUSDT', 'last')).toMatchObject({ available: true, value: 100.5 });
  });

  it('ignores untracked symbols and drops rows that stop being tracked', () => {
    const t = setup();
    t.state.apply('bybit', {
      symbol: 'XRPUSDT',
      values: { last: 1 },
      exchangeTs: null,
      receivedAt: t.now,
      connection: null,
    });
    expect(t.state.tracked('bybit')).toEqual(['BTCUSDT']);
    t.state.setTracked('bybit', ['ETHUSDT']);
    expect(t.state.snapshot('bybit').rows.map((r) => r.symbol)).toEqual(['ETHUSDT']);
  });

  it('summarises data health', () => {
    const t = setup();
    t.state.setInstrumentCount('bybit', 500);
    t.apply({ mark: 100, bid: 99, ask: 101 }, { exchangeTs: t.now - 40 });
    const h = t.state.dataHealth('bybit')!;
    expect(h).toMatchObject({
      instruments: 500,
      tracked: 1,
      fresh: 1,
      invalid: 0,
      latencyMs: 40,
      lastUpdateAt: t.now,
    });
  });
});

describe('validate', () => {
  const now = Date.UTC(2026, 10, 16);
  it.each([
    ['mark', 0, false],
    ['mark', 1e-9, true],
    ['bidSize', 0, true],
    ['openInterest', -1, false],
    ['fundingRate', -0.03, true],
    ['fundingRate', 0.2, false],
    ['fundingIntervalHours', 8, true],
    ['fundingIntervalHours', 0, false],
    ['fundingIntervalHours', 48, false],
    ['nextFundingTime', now + 3_600_000, true],
    ['nextFundingTime', now - 30 * 86_400_000, false],
    ['nextFundingTime', 0, false],
  ] as const)('%s = %d -> valid %s', (field, value, ok) => {
    expect(validate(field, value, now) === null).toBe(ok);
  });
});
