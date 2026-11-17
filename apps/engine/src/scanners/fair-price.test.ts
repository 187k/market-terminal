import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  available,
  defaultSettings,
  MARKET_FIELDS,
  unavailable,
  type ExchangeMarketSnapshot,
  type FairPriceSettings,
  type Field,
  type MarketField,
} from '@mip/core';
import { buildView } from '../view.js';
import { assessRisk, evaluateFairPrice, fairPriceScanner, type FairPriceData } from './fair-price.js';

const defaults = defaultSettings('fair-price') as FairPriceSettings;
const NOW = 1_800_000_000_000;

function fields(values: Partial<Record<MarketField, number>>): Record<MarketField, Field<number>> {
  return Object.fromEntries(
    MARKET_FIELDS.map((f) => [
      f,
      values[f] === undefined ? unavailable('not_received') : available(values[f]!, NOW),
    ]),
  ) as Record<MarketField, Field<number>>;
}

const liquid = {
  index: 100,
  bidSize: 100,
  askSize: 100,
  turnover24h: 50e6,
  fundingRate: 0.0001,
  fundingIntervalHours: 8,
  nextFundingTime: NOW + 3_600_000,
};

function view(
  rows: { symbol: string; f: Partial<Record<MarketField, number>> }[],
  exchange: 'bybit' | 'gate' = 'bybit',
) {
  const snap: ExchangeMarketSnapshot = {
    exchange,
    ts: NOW,
    rows: rows.map((r) => ({ symbol: r.symbol, fields: fields(r.f) })),
  };
  return buildView([snap], null, null, NOW);
}

describe('Fair Price scanner', () => {
  it('flags LONG when the market is below fair and the book still offers it', () => {
    const v = view([{ symbol: 'XUSDT', f: { ...liquid, last: 99.2, mark: 100, bid: 99.1, ask: 99.3 } }]);
    const r = evaluateFairPrice(v, defaults);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c).toMatchObject({ key: 'bybit:XUSDT:LONG', direction: 'LONG', exchange: 'bybit' });
    expect(c.value).toBeCloseTo(-0.8, 12);
    expect((c.data as FairPriceData).executableEdgePct).toBeCloseTo(0.7, 9);
  });

  it('flags SHORT when the market is above fair', () => {
    const v = view([{ symbol: 'XUSDT', f: { ...liquid, last: 101, mark: 100, bid: 100.9, ask: 101.1 } }]);
    expect(evaluateFairPrice(v, defaults).candidates[0]).toMatchObject({
      direction: 'SHORT',
      key: 'bybit:XUSDT:SHORT',
    });
  });

  it('ignores deviations below the threshold', () => {
    const v = view([{ symbol: 'XUSDT', f: { ...liquid, last: 99.6, mark: 100, bid: 99.5, ask: 99.6 } }]);
    expect(evaluateFairPrice(v, defaults).candidates).toHaveLength(0);
    expect(evaluateFairPrice(v, { ...defaults, minDeviationPct: 0.3 }).candidates).toHaveLength(1);
  });

  it('ignores a stale last trade when the book is back at fair (requireExecutable)', () => {
    const v = view([{ symbol: 'XUSDT', f: { ...liquid, last: 98, mark: 100, bid: 99.99, ask: 100.01 } }]);
    expect(evaluateFairPrice(v, defaults).candidates).toHaveLength(0);
    expect(evaluateFairPrice(v, { ...defaults, requireExecutable: false }).candidates).toHaveLength(1);
  });

  it('never signals on missing or stale prices', () => {
    const v = view([{ symbol: 'XUSDT', f: { ...liquid, mark: 100, bid: 98, ask: 98.1 } }]); // no last
    const r = evaluateFairPrice(v, defaults);
    expect(r.candidates).toHaveLength(0);
    expect(r.evaluated).toBe(1);
  });

  it('applies volume, liquidity and spread filters', () => {
    const base = { ...liquid, last: 99, mark: 100, bid: 98.9, ask: 99.0 };
    expect(
      evaluateFairPrice(view([{ symbol: 'A', f: { ...base, turnover24h: 10_000 } }]), defaults).candidates,
    ).toHaveLength(0);
    expect(
      evaluateFairPrice(view([{ symbol: 'B', f: { ...base, askSize: 1 } }]), defaults).candidates,
    ).toHaveLength(0);
    expect(
      evaluateFairPrice(view([{ symbol: 'C', f: { ...base, bid: 95 } }]), defaults).candidates,
    ).toHaveLength(0);
  });

  it('applies exchange and asset filters', () => {
    const v = view([{ symbol: 'XUSDT', f: { ...liquid, last: 99, mark: 100, bid: 98.9, ask: 99 } }]);
    expect(evaluateFairPrice(v, { ...defaults, exchanges: ['gate'] }).candidates).toHaveLength(0);
    expect(evaluateFairPrice(v, { ...defaults, excludeAssets: ['xusdt'] }).candidates).toHaveLength(0);
  });

  it('warns when fair price is far from index', () => {
    const v = view([
      { symbol: 'XUSDT', f: { ...liquid, index: 98, last: 99, mark: 100, bid: 98.9, ask: 99 } },
    ]);
    const d = evaluateFairPrice(v, defaults).candidates[0]!.data as FairPriceData;
    expect(d.fairVsIndexPct).toBeCloseTo((2 / 98) * 100, 9);
    expect(d.fairIndexWarning).toBe(true);
    expect(d.risk.reasons).toContain('fair price far from index');
  });

  it('assesses risk from the number of adverse conditions', () => {
    const calm = {
      deviationPct: -0.8,
      spreadPct: 0.05,
      topOfBookUsd: 50_000,
      fairVsIndexPct: 0.01,
      fairIndexWarnPct: 0.5,
      fundingRate: 0.0001,
      turnover24h: 1e8,
    };
    expect(assessRisk(calm).level).toBe('low');
    expect(assessRisk({ ...calm, spreadPct: 0.5, topOfBookUsd: 100 }).level).toBe('medium');
    expect(assessRisk({ ...calm, spreadPct: 0.5, topOfBookUsd: 100, deviationPct: -5 }).level).toBe('high');
  });

  it('formats an HTML message with the specified fields and escapes text', () => {
    const v = view([{ symbol: 'X<b>USDT', f: { ...liquid, last: 99, mark: 100, bid: 98.9, ask: 99 } }]);
    const c = evaluateFairPrice(v, defaults).candidates[0]!;
    const html = fairPriceScanner.format(c, {
      state: 'active',
      firstSeenAt: NOW,
      updatedAt: NOW,
      updates: 0,
    });
    expect(html).toContain('🟢 <b>LONG</b>');
    expect(html).toContain('X&lt;b&gt;USDT');
    expect(html).toContain('−1.00 %');
    for (const label of [
      'Fair vs index',
      'Executable now',
      'liquidity',
      'Funding',
      'Max leverage',
      'Risk',
      'not a trading recommendation',
    ])
      expect(html).toContain(label);
    const resolved = fairPriceScanner.format(c, {
      state: 'resolved',
      firstSeenAt: NOW,
      updatedAt: NOW + 120_000,
      updates: 1,
    });
    expect(resolved).toContain('✅ <b>Resolved</b>');
  });
});

describe('Fair Price scanner on a recorded market view (real data, 2026-11-17)', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/market-view.json', import.meta.url), 'utf8'));
  const now = Math.max(...fx.snapshots.map((s: { ts: number }) => s.ts)) + 500;
  const v = buildView(fx.snapshots, fx.instruments, fx.universe, now);
  const permissive: FairPriceSettings = {
    ...defaults,
    minDeviationPct: 0,
    requireExecutable: false,
    minTopOfBookUsd: 0,
    minTurnover24hUsd: 0,
    maxSpreadPct: 100,
  };

  it('computes the specified deviation for every instrument with fresh prices', () => {
    const r = evaluateFairPrice(v, permissive);
    expect(r.evaluated).toBe(v.rows.length);
    expect(r.candidates.length).toBeGreaterThan(100);
    for (const c of r.candidates) {
      const row = v.rows.find((x) => x.exchange === c.exchange && x.symbol === c.symbol)!;
      const last = (row.fields.last as { value: number }).value;
      const mark = (row.fields.mark as { value: number }).value;
      expect(c.value).toBeCloseTo(((last - mark) / mark) * 100, 9);
      expect(c.direction).toBe(c.value < 0 ? 'LONG' : 'SHORT');
    }
  });

  it('skips exchanges whose data was stale when recorded (MEXC stream was down)', () => {
    const r = evaluateFairPrice(v, permissive);
    expect(r.candidates.some((c) => c.exchange === 'mexc')).toBe(false);
    expect(v.rows.some((x) => x.exchange === 'mexc')).toBe(true);
  });

  it('with default thresholds only reports deviations that pass every filter', () => {
    const r = evaluateFairPrice(v, defaults);
    for (const c of r.candidates) {
      const d = c.data as FairPriceData;
      expect(Math.abs(d.deviationPct)).toBeGreaterThanOrEqual(defaults.minDeviationPct);
      expect(d.executableEdgePct!).toBeGreaterThanOrEqual(defaults.minExecutableEdgePct);
      expect(d.turnover24h!).toBeGreaterThanOrEqual(defaults.minTurnover24hUsd);
    }
  });
});
