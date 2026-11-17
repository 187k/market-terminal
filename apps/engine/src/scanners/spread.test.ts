import { describe, expect, it } from 'vitest';
import {
  available,
  defaultSettings,
  MARKET_FIELDS,
  unavailable,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type Field,
  type InstrumentInfo,
  type MarketField,
  type SpreadSettings,
  type UniverseInfo,
} from '@mip/core';
import { buildView } from '../view.js';
import { evaluateSpread, formatSpread, type DepthSource, type SpreadData } from './spread.js';

const defaults = defaultSettings('spread') as SpreadSettings;
const NOW = 1_800_000_000_000;

function fields(values: Partial<Record<MarketField, number>>, ts = NOW): Record<MarketField, Field<number>> {
  return Object.fromEntries(
    MARKET_FIELDS.map((f) => [
      f,
      values[f] === undefined ? unavailable('not_received') : available(values[f]!, ts),
    ]),
  ) as Record<MarketField, Field<number>>;
}

interface LegSpec {
  exchange: ExchangeId;
  symbol: string;
  bid: number;
  ask: number;
  multiplier?: number;
  quote?: string;
  funding?: number;
  ts?: number;
}

function view(legs: LegSpec[]) {
  const snapshots: ExchangeMarketSnapshot[] = legs.map((l) => ({
    exchange: l.exchange,
    ts: NOW,
    rows: [
      {
        symbol: l.symbol,
        fields: fields(
          {
            bid: l.bid,
            ask: l.ask,
            bidSize: 1e6,
            askSize: 1e6,
            mark: (l.bid + l.ask) / 2,
            fundingRate: l.funding ?? 0.0001,
            fundingIntervalHours: 8,
            turnover24h: 1e8,
          },
          l.ts ?? NOW,
        ),
      },
    ],
  }));
  const universe: UniverseInfo = {
    source: 'coingecko',
    builtAt: NOW,
    size: 1,
    problems: [],
    warnings: [],
    assets: [
      {
        id: 'pepe',
        symbol: 'PEPE',
        name: 'Pepe',
        rank: 1,
        marketCapRank: 1,
        marketCapUsd: 1,
        priceUsd: 1,
        instruments: legs.map((l) => ({ exchange: l.exchange, symbol: l.symbol })),
      },
    ],
  };
  const instruments = {
    ts: NOW,
    capabilities: {},
    instruments: Object.fromEntries(
      legs.map((l) => [
        l.exchange,
        [
          {
            exchange: l.exchange,
            symbol: l.symbol,
            multiplier: l.multiplier ?? 1,
            contractSize: 1,
            quote: l.quote ?? 'USDT',
            indexKind: 'index',
            url: null,
          } as unknown as InstrumentInfo,
        ],
      ]),
    ),
  };
  return buildView(snapshots, instruments, universe, NOW);
}

/** Depth with ample size at the top price (no slippage) unless overridden. */
function depthOf(
  books: Partial<Record<ExchangeId, { bids?: [number, number][]; asks?: [number, number][] }>>,
  fail = false,
): DepthSource {
  return {
    async fetch(exchange) {
      if (fail) throw new Error('HTTP 418: banned');
      const b = books[exchange] ?? {};
      return { bids: b.bids ?? [], asks: b.asks ?? [] };
    },
  };
}

describe('Spread scanner', () => {
  const twoLegs: LegSpec[] = [
    { exchange: 'bybit', symbol: 'PEPEUSDT', bid: 99.9, ask: 100 },
    { exchange: 'gate', symbol: 'PEPE_USDT', bid: 101, ask: 101.1 },
  ];
  const ample = depthOf({ bybit: { asks: [[100, 1e6]] }, gate: { bids: [[101, 1e6]] } });

  it('buys at the cheaper ask, sells at the dearer bid, and follows the profit steps', async () => {
    const r = await evaluateSpread(view(twoLegs), { ...defaults, holdingHours: 0 }, ample);
    const c = r.candidates[0]!;
    expect(c.key).toBe('pepe:bybit:gate');
    const d = c.data as SpreadData;
    expect(d.grossPct).toBeCloseTo(1, 12);
    expect(d.qty).toBeCloseTo(100, 12); // $10,000 / 100
    expect(d.breakdown.purchaseCost).toBeCloseTo(10_000, 9);
    expect(d.breakdown.saleProceeds).toBeCloseTo(10_100, 9);
    expect(d.breakdown.fees).toBeCloseTo(10_000 * 0.00055 + 10_100 * 0.00075, 9);
    expect(c.value).toBeCloseTo(((100 - 5.5 - 7.575) / 10_000) * 100, 9);
  });

  it('uses VWAP for the position size, so thin books reduce the net', async () => {
    const thin = depthOf({
      bybit: {
        asks: [
          [100, 50],
          [100.5, 1e6],
        ],
      },
      gate: { bids: [[101, 1e6]] },
    });
    const d = (await evaluateSpread(view(twoLegs), { ...defaults, holdingHours: 0 }, thin)).candidates[0]!
      .data as SpreadData;
    expect(d.execution.buyVwap).toBeCloseTo((50 * 100 + 50 * 100.5) / 100, 9);
    expect(d.execution.buySlippagePct).toBeCloseTo(0.25, 9);
  });

  it('normalises contract units (1000PEPE vs PEPE) before comparing', async () => {
    const legs: LegSpec[] = [
      { exchange: 'bybit', symbol: '1000PEPEUSDT', bid: 0.003779, ask: 0.00378, multiplier: 1000 },
      { exchange: 'gate', symbol: 'PEPE_USDT', bid: 0.0000039, ask: 0.00000391 },
    ];
    const depth = depthOf({ bybit: { asks: [[0.00378, 1e12]] }, gate: { bids: [[0.0000039, 1e12]] } });
    const d = (await evaluateSpread(view(legs), { ...defaults, holdingHours: 0 }, depth)).candidates[0]!
      .data as SpreadData;
    expect(d.buy.ask).toBeCloseTo(0.00000378, 15);
    expect(d.grossPct).toBeCloseTo(((0.0000039 - 0.00000378) / 0.00000378) * 100, 9);
    expect(d.compatibility.join(' ')).toContain('contract units differ');
  });

  it('charges funding over the holding period in the right direction', async () => {
    // long leg pays +0.03 %/8h, short leg receives +0.09 %/8h -> net credit
    const legs: LegSpec[] = [
      { ...twoLegs[0]!, funding: 0.0003 },
      { ...twoLegs[1]!, funding: 0.0009 },
    ];
    const d = (await evaluateSpread(view(legs), defaults, ample)).candidates[0]!.data as SpreadData;
    // 10,000 × (0.0009 − 0.0027) × 8/24 = −6 (a credit)
    expect(d.breakdown.fundingCost).toBeCloseTo(-6, 9);
  });

  it('quarantines implausible gaps instead of signalling them', async () => {
    const legs: LegSpec[] = [twoLegs[0]!, { ...twoLegs[1]!, bid: 130, ask: 130.1 }];
    const r = await evaluateSpread(view(legs), defaults, ample);
    expect(r.candidates).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/quarantined as a probable mapping problem/);
  });

  it('requires both quotes to be fresh at about the same time', async () => {
    const legs: LegSpec[] = [twoLegs[0]!, { ...twoLegs[1]!, ts: NOW - 10_000 }];
    expect((await evaluateSpread(view(legs), defaults, ample)).candidates).toHaveLength(0);
  });

  it('labels the result preliminary when the order book is unavailable', async () => {
    const d = (await evaluateSpread(view(twoLegs), { ...defaults, holdingHours: 0 }, depthOf({}, true)))
      .candidates[0]!.data as SpreadData;
    expect(d.execution.error).toBe('HTTP 418: banned');
    expect(d.preliminary[0]).toMatch(/order book unavailable/);
    expect(d.risk.reasons).toContain('depth incomplete');
  });

  it('can exclude USDC-quoted venues', async () => {
    const legs: LegSpec[] = [
      twoLegs[0]!,
      { exchange: 'hyperliquid', symbol: 'PEPE', bid: 101, ask: 101.1, quote: 'USDC' },
    ];
    const depth = depthOf({ bybit: { asks: [[100, 1e6]] }, hyperliquid: { bids: [[101, 1e6]] } });
    expect((await evaluateSpread(view(legs), defaults, depth)).candidates).toHaveLength(1);
    expect(
      (await evaluateSpread(view(legs), { ...defaults, allowMixedQuotes: false }, depth)).candidates,
    ).toHaveLength(0);
  });

  it('formats every specified field', async () => {
    const c = (await evaluateSpread(view(twoLegs), defaults, ample)).candidates[0]!;
    const html = formatSpread(c, { state: 'active', firstSeenAt: NOW, updatedAt: NOW, updates: 0 });
    for (const s of [
      'BUY / LONG on <b>Bybit',
      'SELL / SHORT on <b>Gate',
      'net <b>',
      'gross',
      'fees',
      'funding over 8 h',
      'Slippage',
      'average price',
      'Deviation from average',
      'Compatibility',
      'Deposit / withdrawal',
      'Preliminary',
      'Risk',
      'basis position',
    ])
      expect(html).toContain(s);
  });
});
