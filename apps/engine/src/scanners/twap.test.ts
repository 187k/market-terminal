import { describe, expect, it } from 'vitest';
import {
  available,
  defaultSettings,
  MARKET_FIELDS,
  unavailable,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type Field,
  type MarketField,
  type TradeEvent,
  type TwapSettings,
} from '@mip/core';
import { parseTwapHistory, type TwapOrder } from '../hl-twap.js';
import { TradeBuffer } from '../trades.js';
import { buildView } from '../view.js';
import {
  confirmedGroups,
  evaluateTwap,
  findPattern,
  formatTwap,
  toExecutions,
  type TwapData,
} from './twap.js';

const defaults = defaultSettings('twap') as TwapSettings;
const NOW = 1_800_000_000_000;

/** Deterministic pseudo-random numbers (mulberry32) so tests never flake. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const trade = (
  ts: number,
  side: 'buy' | 'sell',
  size: number,
  price = 100,
  exchange: ExchangeId = 'bybit',
  extra: Partial<TradeEvent> = {},
): TradeEvent => ({
  exchange,
  symbol: 'XUSDT',
  ts,
  price,
  size,
  side,
  ...extra,
});

/** A TWAP: `n` buys of ~`size` every `everyMs` (± jitter), ending `endAgoMs` before NOW. */
function twapTrades(
  n: number,
  size: number,
  everyMs: number,
  opts: { jitter?: number; endAgoMs?: number; seed?: number } = {},
) {
  const r = rng(opts.seed ?? 1);
  const end = NOW - (opts.endAgoMs ?? 5_000);
  return Array.from({ length: n }, (_, i) =>
    trade(
      end - (n - 1 - i) * everyMs + Math.round((r() - 0.5) * (opts.jitter ?? 0)),
      'buy',
      size * (1 + (r() - 0.5) * 0.04),
    ),
  );
}

function fields(values: Partial<Record<MarketField, number>>): Record<MarketField, Field<number>> {
  return Object.fromEntries(
    MARKET_FIELDS.map((f) => [
      f,
      values[f] === undefined ? unavailable('not_received') : available(values[f]!, NOW),
    ]),
  ) as Record<MarketField, Field<number>>;
}

function viewFor(exchange: ExchangeId, symbol: string) {
  const snap: ExchangeMarketSnapshot = {
    exchange,
    ts: NOW,
    rows: [{ symbol, fields: fields({ mark: 102, turnover24h: 5e8 }) }],
  };
  return buildView([snap], null, null, NOW);
}

describe('TWAP pattern detection', () => {
  it('scores a regular, similar-size, one-sided sequence highly', () => {
    const p = findPattern(toExecutions(twapTrades(20, 50, 30_000, { jitter: 1_000 })), 'buy', defaults, NOW)!;
    expect(p.slices).toBe(20);
    expect(p.cvInterval).toBeLessThan(0.05);
    expect(p.oneSided).toBe(1);
    expect(p.confidence).toBeGreaterThan(0.85);
    expect(p.status).toBe('active');
    expect(p.executedNotional).toBeCloseTo(20 * 50 * 100, -3);
  });

  it('does not see a pattern in random two-sided retail flow', () => {
    const r = rng(7);
    const trades: TradeEvent[] = [];
    let t = NOW - 20 * 60_000;
    for (let i = 0; i < 80; i++) {
      t += Math.round(-Math.log(1 - r()) * 15_000); // Poisson arrivals
      trades.push(trade(t, r() < 0.5 ? 'buy' : 'sell', Math.exp(r() * 5)));
    }
    for (const side of ['buy', 'sell'] as const) {
      const p = findPattern(toExecutions(trades), side, defaults, NOW);
      expect(p === null || p.confidence < defaults.minConfidence).toBe(true);
    }
  });

  it('scores same-size trades at random times below the reporting threshold', () => {
    const r = rng(3);
    const trades: TradeEvent[] = [];
    let t = NOW - 25 * 60_000;
    for (let i = 0; i < 25; i++) {
      t += Math.round(-Math.log(1 - r()) * 40_000);
      trades.push(trade(t, i % 3 === 0 ? 'sell' : 'buy', 10)); // a common lot size, irregular timing, mixed sides
    }
    const p = findPattern(toExecutions(trades), 'buy', defaults, NOW);
    expect(p === null || p.confidence < defaults.minConfidence).toBe(true);
  });

  it('merges fills of one taker order into one execution', () => {
    const fills = [
      trade(1000, 'buy', 1, 100),
      trade(1000, 'buy', 3, 101),
      trade(1000, 'buy', 1, 102),
      trade(2000, 'buy', 2),
    ];
    const ex = toExecutions(fills);
    expect(ex).toHaveLength(2);
    expect(ex[0]).toMatchObject({ ts: 1000, size: 5 });
    expect(ex[0]!.price).toBeCloseTo((100 + 303 + 102) / 5, 12);
  });

  it('marks a pattern completed when slices stopped', () => {
    const p = findPattern(
      toExecutions(twapTrades(15, 50, 20_000, { endAgoMs: 10 * 60_000 })),
      'buy',
      defaults,
      NOW,
    )!;
    expect(p.status).toBe('completed');
  });

  it('requires enough slices and duration', () => {
    expect(findPattern(toExecutions(twapTrades(5, 50, 30_000)), 'buy', defaults, NOW)).toBeNull();
    expect(findPattern(toExecutions(twapTrades(15, 50, 1_000)), 'buy', defaults, NOW)).toBeNull(); // 14 s total
  });
});

describe('TWAP scanner', () => {
  it('reports a heuristic pattern labelled as an algorithmic assumption', () => {
    const buffer = new TradeBuffer(30 * 60_000);
    buffer.add(twapTrades(20, 50, 30_000, { jitter: 1_000 }));
    const c = evaluateTwap(viewFor('bybit', 'XUSDT'), defaults, buffer, null, NOW).candidates[0]!;
    expect(c.key).toBe('bybit:XUSDT:BUY');
    const d = c.data as TwapData;
    expect(d).toMatchObject({
      kind: 'heuristic',
      side: 'BUY',
      status: 'active',
      wallet: null,
      executedPct: null,
    });
    expect(d.label).toMatch(/algorithmic assumption/);
    expect(d.priceChangePct).toBeCloseTo(2, 9); // mark 102 vs first slice 100
    const html = formatTwap(c, { state: 'active', firstSeenAt: NOW, updatedAt: NOW, updates: 0 });
    for (const s of [
      'Possible TWAP / DCA',
      'algorithmic assumption',
      'confidence',
      'Average execution price',
      'price change since start',
      'Market cap',
      'not available on this exchange',
    ])
      expect(html).toContain(s);
  });

  it('reports Hyperliquid zero-hash slices as exchange-confirmed with the order from userTwapHistory', () => {
    const wallet = '0xAbC0000000000000000000000000000000000001';
    const zero = '0x' + '0'.repeat(64);
    const trades = Array.from({ length: 6 }, (_, i) =>
      trade(NOW - 60_000 + i * 10_000, 'buy', 100, 100, 'hyperliquid', {
        symbol: 'BTC',
        hash: zero,
        users: [wallet, '0xmaker'],
      }),
    );
    expect(confirmedGroups(trades)[0]).toMatchObject({ wallet: wallet.toLowerCase(), side: 'buy' });
    const order: TwapOrder = {
      coin: 'BTC',
      user: wallet.toLowerCase(),
      side: 'B',
      sz: 2000,
      executedSz: 600,
      executedNtl: 60_000,
      minutes: 30,
      randomize: true,
      reduceOnly: false,
      startedAt: NOW - 300_000,
      status: 'activated',
      statusAt: NOW - 300_000,
    };
    const watched: string[] = [];
    const watcher = { watch: (u: string) => void watched.push(u), orders: () => [order] };
    const buffer = new TradeBuffer(30 * 60_000);
    buffer.add(trades);
    const c = evaluateTwap(viewFor('hyperliquid', 'BTC'), defaults, buffer, watcher, NOW).candidates[0]!;
    expect(watched).toEqual([wallet.toLowerCase()]);
    const d = c.data as TwapData;
    // An active order: Hyperliquid reports no progress yet, so show time elapsed and what we saw.
    expect(d).toMatchObject({
      kind: 'confirmed',
      status: 'active',
      wallet: wallet.toLowerCase(),
      executedPct: null,
      executedSource: 'observed',
      executedNotional: 60_000,
      walletTwapCount: 1,
    });
    expect(d.elapsedPct).toBeCloseTo((300_000 / 1_800_000) * 100, 9);
    expect(d.orderNotional).toBeCloseTo(2000 * 102, 9);
    expect(d.twap).toMatchObject({ minutes: 30, randomize: true });
    const html = formatTwap(c, { state: 'active', firstSeenAt: NOW, updatedAt: NOW, updates: 0 });
    expect(html).toContain('TWAP (exchange-confirmed)');
    expect(html).toContain(wallet.toLowerCase());
    expect(html).toContain('of its scheduled time elapsed');

    // Once finished, the exchange's own executed figures are used.
    const done = { ...order, status: 'finished', executedSz: 2000, executedNtl: 201_000 };
    const finished = evaluateTwap(
      viewFor('hyperliquid', 'BTC'),
      defaults,
      buffer,
      { watch: () => undefined, orders: () => [done] },
      NOW,
    ).candidates[0]!.data as TwapData;
    expect(finished).toMatchObject({
      status: 'completed',
      executedPct: 100,
      executedSource: 'exchange',
      executedNotional: 201_000,
      elapsedPct: null,
    });
  });

  it('parses the documented WsTwapHistory shape', () => {
    const orders = parseTwapHistory([
      {
        state: {
          coin: 'ETH',
          user: '0x1',
          side: 'A',
          sz: 10,
          executedSz: 4,
          executedNtl: 7_200,
          minutes: 60,
          reduceOnly: false,
          randomize: false,
          timestamp: 5,
        },
        status: { status: 'finished', description: '' },
        time: 9,
      },
      { nonsense: true },
    ]);
    expect(orders).toEqual([
      {
        coin: 'ETH',
        user: '0x1',
        side: 'A',
        sz: 10,
        executedSz: 4,
        executedNtl: 7200,
        minutes: 60,
        randomize: false,
        reduceOnly: false,
        startedAt: 5,
        status: 'finished',
        statusAt: 9,
      },
    ]);
  });
});

describe('TradeBuffer', () => {
  it('keeps trades sorted and trims by window', () => {
    const b = new TradeBuffer(60_000);
    b.add([trade(NOW - 30_000, 'buy', 1), trade(NOW - 90_000, 'buy', 1), trade(NOW - 10_000, 'sell', 1)]);
    expect(b.get('bybit', 'XUSDT').map((t) => t.ts)).toEqual([NOW - 90_000, NOW - 30_000, NOW - 10_000]);
    b.trim(NOW);
    expect(b.get('bybit', 'XUSDT')).toHaveLength(2);
  });
});
