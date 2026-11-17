import { OI_SCENARIOS, oiChange, oiScenario, pctDiff, sampleAt } from '@mip/analytics';
import {
  OI_WINDOW_MS,
  OI_WINDOWS,
  type OiWindow,
  type OiWindowResult as WindowResult,
  type OpenInterestData,
  type OpenInterestSettings,
} from '@mip/core';
import { compact, duration, esc, exchangeName, footer, link, pct, price, rate, usd } from '../format.js';
import type { HistoryPoint, SnapshotHistory } from '../history.js';
import { val, type MarketView } from '../view.js';
import {
  passesCommonFilters,
  type Candidate,
  type EvaluationResult,
  type ScannerDefinition,
} from './types.js';

export type { OpenInterestData, WindowResult };

/** Tolerance for "a snapshot at t − window": ±90 s for short windows, ±10 % for long ones. */
export const toleranceFor = (windowMs: number) => Math.max(90_000, windowMs * 0.1);

/** Per-exchange caveats on how OI is obtained. */
const OI_NOTES: Partial<Record<string, string>> = {
  binance: 'OI polled every 30 s (no stream), so short windows rest on few points',
  bingx: 'OI polled every 60 s and converted from USDT notional with the mark price',
};

export function windowsFor(
  points: readonly HistoryPoint[],
  current: number,
  mark: number,
  now: number,
  coverageMs: number,
): Record<OiWindow, WindowResult> {
  const oiSeries = points
    .filter((p) => p.openInterest !== null)
    .map((p) => ({ ts: p.ts, value: p.openInterest! }));
  const out = {} as Record<OiWindow, WindowResult>;
  for (const w of OI_WINDOWS) {
    const ms = OI_WINDOW_MS[w];
    const prev = sampleAt(oiSeries, now - ms, toleranceFor(ms));
    if (!prev) {
      out[w] = { available: false, reason: coverageMs < ms ? 'warming_up' : 'no_snapshot' };
      continue;
    }
    const ch = oiChange(current, prev.value, mark);
    if (!ch) {
      out[w] = { available: false, reason: 'no_snapshot' };
      continue;
    }
    const point = points.find((p) => p.ts === prev.ts);
    const prevPrice = point?.mark ?? point?.last ?? null;
    const priceChangePct = prevPrice === null ? null : pctDiff(mark, prevPrice);
    out[w] = {
      available: true,
      changePct: ch.changePct,
      changeBase: ch.changeBase,
      changeUsd: ch.changeUsd,
      previous: ch.previous,
      previousTs: prev.ts,
      priceChangePct,
      scenario: priceChangePct === null ? null : oiScenario(priceChangePct, ch.changePct),
    };
  }
  return out;
}

export function evaluateOpenInterest(
  view: MarketView,
  s: OpenInterestSettings,
  history: Pick<SnapshotHistory, 'series' | 'coverageMs'>,
  now: number,
): EvaluationResult {
  const candidates: Candidate[] = [];
  let evaluated = 0;
  const coverage = history.coverageMs(now);
  for (const row of view.rows) {
    const assetCode = row.asset?.symbol ?? row.instrument?.asset ?? row.symbol;
    if (!passesCommonFilters(s, row.exchange, assetCode)) continue;
    const f = row.fields;
    const oi = val(f.openInterest);
    const mark = val(f.mark) ?? val(f.last);
    if (oi === null || mark === null) continue;
    evaluated++;
    const oiUsd = oi * mark;
    if (oiUsd < s.minOiUsd) continue;
    const turnover = val(f.turnover24h);
    if (s.minTurnover24hUsd > 0 && (turnover === null || turnover < s.minTurnover24hUsd)) continue;
    if (s.minTopOfBookUsd > 0) {
      const bidUsd = (val(f.bid) ?? 0) * (val(f.bidSize) ?? 0);
      const askUsd = (val(f.ask) ?? 0) * (val(f.askSize) ?? 0);
      if (Math.min(bidUsd, askUsd) < s.minTopOfBookUsd) continue;
    }
    const windows = windowsFor(history.series(row.exchange, row.symbol), oi, mark, now, coverage);
    let best: { w: OiWindow; ratio: number; dir: 'UP' | 'DOWN' } | null = null;
    for (const w of OI_WINDOWS) {
      const r = windows[w];
      if (!r.available) continue;
      const t = s.thresholds[w];
      if (s.signalOnGrowth && t.growthPct > 0 && r.changePct >= t.growthPct) {
        const ratio = r.changePct / t.growthPct;
        if (!best || ratio > best.ratio) best = { w, ratio, dir: 'UP' };
      }
      if (s.signalOnDecline && t.declinePct > 0 && r.changePct <= -t.declinePct) {
        const ratio = -r.changePct / t.declinePct;
        if (!best || ratio > best.ratio) best = { w, ratio, dir: 'DOWN' };
      }
    }
    if (!best) continue;
    const primary = windows[best.w] as Extract<WindowResult, { available: true }>;
    const data: OpenInterestData = {
      exchange: row.exchange,
      symbol: row.symbol,
      asset: assetCode,
      url: row.instrument?.url ?? null,
      direction: best.dir,
      primaryWindow: best.w,
      windows,
      openInterest: oi,
      openInterestUsd: oiUsd,
      price: mark,
      fundingRate: val(f.fundingRate),
      fundingIntervalHours: val(f.fundingIntervalHours),
      turnover24h: turnover,
      longShortRatio: null,
      oiNote: OI_NOTES[row.exchange] ?? null,
    };
    candidates.push({
      key: `${row.exchange}:${row.symbol}:OI_${best.dir}`,
      exchange: row.exchange,
      symbol: row.symbol,
      asset: assetCode,
      direction: best.dir === 'UP' ? 'OI_UP' : 'OI_DOWN',
      value: primary.changePct,
      title: `OI ${pct(primary.changePct, 1)} in ${best.w} · ${row.symbol} on ${exchangeName(row.exchange)} (price ${pct(primary.priceChangePct, 1)})`,
      data,
    });
  }
  const warnings: string[] = [];
  if (coverage < OI_WINDOW_MS['4h'])
    warnings.push(
      `OI history covers ${duration(coverage)} of 4h; windows longer than that are warming up (no exchange backfill in this version)`,
    );
  if (view.staleExchanges.length > 0)
    warnings.push(`no fresh data from: ${view.staleExchanges.map(exchangeName).join(', ')}`);
  return { candidates, evaluated, warnings };
}

export function formatOpenInterest(
  signal: { data: Record<string, unknown> },
  status: Parameters<typeof footer>[0],
): string {
  const d = signal.data as OpenInterestData;
  const primary = d.windows[d.primaryWindow] as Extract<WindowResult, { available: true }>;
  const head = `${d.direction === 'UP' ? '📈 <b>OI rising</b>' : '📉 <b>OI falling</b>'} · ${link(d.symbol, d.url)} · ${esc(exchangeName(d.exchange))}`;
  const rows = OI_WINDOWS.map((w) => {
    const r = d.windows[w];
    if (!r.available) return `${w}: ${r.reason === 'warming_up' ? 'warming up' : 'no data'}`;
    return `${w}: OI <b>${pct(r.changePct, 1)}</b> (${r.changeBase >= 0 ? '+' : '−'}${compact(Math.abs(r.changeBase))} coins, ${r.changeUsd >= 0 ? '+' : '−'}${usd(r.changeUsd)}) · price ${pct(r.priceChangePct, 1)}`;
  });
  const scenario = primary.scenario ? OI_SCENARIOS[primary.scenario] : null;
  return [
    head,
    ...rows,
    `OI now ${compact(d.openInterest)} coins (${usd(d.openInterestUsd)}) · was ${compact(primary.previous)} ${d.primaryWindow} ago`,
    `Price ${price(d.price)} · funding ${rate(d.fundingRate)} / ${d.fundingIntervalHours ?? '—'} h · 24 h turnover ${usd(d.turnover24h)}`,
    `Long/short ratio: not collected in this version`,
    scenario ? `Scenario ${primary.scenario}: <b>${esc(scenario.label)}</b>. ${esc(scenario.reading)}` : '',
    `<i>Every open contract has a long and a short side; OI growth alone does not mean new longs.</i>`,
    d.oiNote ? `<i>Note: ${esc(d.oiNote)}.</i>` : '',
    footer(status),
  ]
    .filter(Boolean)
    .join('\n');
}

export function createOpenInterestScanner(history: SnapshotHistory): ScannerDefinition<OpenInterestSettings> {
  return {
    id: 'open-interest',
    intervalMs: 30_000,
    evaluate: (view, settings, now) => evaluateOpenInterest(view, settings, history, now),
    format: formatOpenInterest,
    significantChange(prev, next, settings) {
      const a = prev.data as OpenInterestData;
      const b = next.data as OpenInterestData;
      if (a.primaryWindow !== b.primaryWindow) return true;
      return (
        Math.abs(next.value - prev.value) / Math.max(Math.abs(prev.value), 1e-9) >=
        settings.significantChangePct / 100
      );
    },
  };
}
