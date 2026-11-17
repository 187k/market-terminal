import { describe, expect, it } from 'vitest';
import {
  available,
  defaultSettings,
  MARKET_FIELDS,
  unavailable,
  type ExchangeMarketSnapshot,
  type Field,
  type MarketField,
  type OpenInterestSettings,
} from '@mip/core';
import { SnapshotHistory, type HistoryRow } from '../history.js';
import { buildView } from '../view.js';
import {
  evaluateOpenInterest,
  formatOpenInterest,
  windowsFor,
  type OpenInterestData,
} from './open-interest.js';

const defaults = defaultSettings('open-interest') as OpenInterestSettings;
const MIN = 60_000;
const NOW = Math.floor(1_800_000_000_000 / MIN) * MIN + 10_000;

function fields(values: Partial<Record<MarketField, number>>): Record<MarketField, Field<number>> {
  return Object.fromEntries(
    MARKET_FIELDS.map((f) => [
      f,
      values[f] === undefined ? unavailable('not_received') : available(values[f]!, NOW),
    ]),
  ) as Record<MarketField, Field<number>>;
}

const live = {
  bid: 99.9,
  ask: 100,
  bidSize: 500,
  askSize: 500,
  turnover24h: 1e8,
  fundingRate: 0.0001,
  fundingIntervalHours: 8,
};

/** History with one point per minute for `minutes`, OI and mark given as functions of minutes ago. */
async function historyOf(
  minutes: number,
  oiAt: (ago: number) => number | null,
  markAt: (ago: number) => number = () => 100,
) {
  const rows: HistoryRow[] = [];
  for (let ago = minutes; ago >= 1; ago--) {
    rows.push({
      exchange: 'bybit',
      symbol: 'XUSDT',
      ts: Math.floor(NOW / MIN) * MIN - ago * MIN,
      mark: markAt(ago),
      last: null,
      openInterest: oiAt(ago),
      fundingRate: null,
      fundingInterval: null,
      nextFundingTime: null,
    });
  }
  const h = new SnapshotHistory(
    { since: async (after) => rows.filter((r) => r.ts > after) },
    4.5 * 3_600_000,
  );
  await h.refresh(NOW);
  return h;
}

function view(oi: number, mark = 100) {
  const snap: ExchangeMarketSnapshot = {
    exchange: 'bybit',
    ts: NOW,
    rows: [{ symbol: 'XUSDT', fields: fields({ ...live, openInterest: oi, mark }) }],
  };
  return buildView([snap], null, null, NOW);
}

describe('Open Interest windows', () => {
  it('computes change against the snapshot nearest t − window, with price change and scenario', async () => {
    const h = await historyOf(
      300,
      () => 100_000,
      (ago) => (ago >= 30 ? 98 : 100),
    );
    const w = windowsFor(h.series('bybit', 'XUSDT'), 110_000, 100, NOW, h.coverageMs(NOW));
    expect(w['30m']).toMatchObject({
      available: true,
      changeBase: 10_000,
      changeUsd: 1_000_000,
      previous: 100_000,
      scenario: 1,
    });
    expect((w['30m'] as { changePct: number }).changePct).toBeCloseTo(10, 9);
    expect((w['30m'] as { priceChangePct: number }).priceChangePct).toBeCloseTo((2 / 98) * 100, 9);
  });

  it('reports windows longer than the history as warming up, never guesses', async () => {
    const h = await historyOf(40, () => 100_000);
    const w = windowsFor(h.series('bybit', 'XUSDT'), 100_000, 100, NOW, h.coverageMs(NOW));
    expect(w['5m'].available).toBe(true);
    expect(w['30m'].available).toBe(true);
    expect(w['1h']).toEqual({ available: false, reason: 'warming_up' });
    expect(w['4h']).toEqual({ available: false, reason: 'warming_up' });
  });

  it('marks a gap in the history as missing rather than using a far-away point', async () => {
    const h = await historyOf(300, (ago) => (ago > 20 && ago < 40 ? null : 100_000));
    const w = windowsFor(h.series('bybit', 'XUSDT'), 100_000, 100, NOW, h.coverageMs(NOW));
    expect(w['30m']).toEqual({ available: false, reason: 'no_snapshot' });
  });
});

describe('Open Interest scanner', () => {
  it('signals OI growth above a window threshold, picking the strongest window', async () => {
    const h = await historyOf(300, (ago) => (ago <= 5 ? 109_000 : 100_000));
    // 5 m: +0.9 % (below 3 %); 30 m: +10 % (above 8 %); 1 h +10 % (below 12 %)
    const r = evaluateOpenInterest(view(110_000), defaults, h, NOW);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c).toMatchObject({ key: 'bybit:XUSDT:OI_UP', direction: 'OI_UP' });
    expect((c.data as OpenInterestData).primaryWindow).toBe('30m');
    expect(c.value).toBeCloseTo(10, 9);
  });

  it('signals OI decline, classifying price ↓ + OI ↓', async () => {
    const h = await historyOf(
      300,
      () => 100_000,
      () => 105,
    );
    const r = evaluateOpenInterest(view(90_000, 100), defaults, h, NOW);
    const c = r.candidates[0]!;
    expect(c.direction).toBe('OI_DOWN');
    const d = c.data as OpenInterestData;
    // −10 % in every window: strongest relative to its threshold is 5 m (3 %), ratio 3.3
    expect(d.primaryWindow).toBe('5m');
    expect((d.windows['5m'] as { scenario: number }).scenario).toBe(4);
  });

  it('respects growth/decline switches and the OI size filter', async () => {
    const h = await historyOf(300, () => 100_000);
    expect(
      evaluateOpenInterest(view(90_000), { ...defaults, signalOnDecline: false }, h, NOW).candidates,
    ).toHaveLength(0);
    expect(evaluateOpenInterest(view(150_000, 1), defaults, h, NOW).candidates).toHaveLength(0); // OI worth $150k
  });

  it('warns while the history is shorter than 4 h', async () => {
    const h = await historyOf(40, () => 100_000);
    expect(evaluateOpenInterest(view(100_000), defaults, h, NOW).warnings[0]).toMatch(/covers 40m of 4h/);
  });

  it('formats every window, the scenario and the counterparty caveat', async () => {
    const h = await historyOf(
      300,
      (ago) => (ago <= 5 ? 109_000 : 100_000),
      () => 98,
    );
    const c = evaluateOpenInterest(view(110_000), defaults, h, NOW).candidates[0]!;
    const html = formatOpenInterest(c, { state: 'active', firstSeenAt: NOW, updatedAt: NOW, updates: 0 });
    for (const s of [
      '📈 <b>OI rising</b>',
      '5m:',
      '30m:',
      '1h:',
      '4h:',
      'Scenario',
      'long and a short side',
      'Long/short ratio',
    ])
      expect(html).toContain(s);
  });
});
