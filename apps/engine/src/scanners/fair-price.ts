import { fairPriceMetrics } from '@mip/analytics';
import type { FairPriceData, FairPriceSettings, RiskAssessment } from '@mip/core';
import { esc, exchangeName, footer, link, pct, price, rate, usd } from '../format.js';
import { val, type MarketView } from '../view.js';
import {
  passesCommonFilters,
  type Candidate,
  type EvaluationResult,
  type ScannerDefinition,
} from './types.js';

export type { FairPriceData, RiskAssessment };

/**
 * Heuristic risk level from conditions that make a fair-price deviation hard to trade or
 * likely to persist: 0–1 reasons = low, 2 = medium, 3+ = high.
 */
export function assessRisk(x: {
  deviationPct: number;
  spreadPct: number | null;
  topOfBookUsd: number | null;
  fairVsIndexPct: number | null;
  fairIndexWarnPct: number;
  fundingRate: number | null;
  turnover24h: number | null;
}): RiskAssessment {
  const reasons: string[] = [];
  if (x.spreadPct !== null && x.spreadPct > 0.3) reasons.push(`wide spread (${x.spreadPct.toFixed(2)} %)`);
  if (x.topOfBookUsd !== null && x.topOfBookUsd < 5_000) reasons.push('thin book at the best level');
  if (x.fairVsIndexPct !== null && Math.abs(x.fairVsIndexPct) >= x.fairIndexWarnPct)
    reasons.push('fair price far from index');
  if (x.fundingRate !== null && Math.abs(x.fundingRate) >= 0.001) reasons.push('extreme funding');
  if (Math.abs(x.deviationPct) >= 3)
    reasons.push('very large deviation (often an illiquid or halted market)');
  if (x.turnover24h !== null && x.turnover24h < 5_000_000) reasons.push('low 24 h volume');
  return { level: reasons.length >= 3 ? 'high' : reasons.length === 2 ? 'medium' : 'low', reasons };
}

export function evaluateFairPrice(view: MarketView, s: FairPriceSettings): EvaluationResult {
  const candidates: Candidate[] = [];
  let evaluated = 0;
  let missing = 0;
  for (const row of view.rows) {
    const assetCode = row.asset?.symbol ?? row.instrument?.asset ?? row.symbol;
    if (!passesCommonFilters(s, row.exchange, assetCode)) continue;
    evaluated++;
    const f = row.fields;
    const last = val(f.last);
    const mark = val(f.mark);
    // Stale or missing data never produces a signal.
    if (last === null || mark === null) {
      missing++;
      continue;
    }
    const m = fairPriceMetrics({
      last,
      mark,
      index: val(f.index),
      bid: val(f.bid),
      ask: val(f.ask),
      bidSize: val(f.bidSize),
      askSize: val(f.askSize),
    });
    if (!m || Math.abs(m.deviationPct) < s.minDeviationPct) continue;
    const turnover = val(f.turnover24h);
    if (s.minTurnover24hUsd > 0 && (turnover === null || turnover < s.minTurnover24hUsd)) continue;
    if (s.minTopOfBookUsd > 0 && (m.topOfBookUsd === null || m.topOfBookUsd < s.minTopOfBookUsd)) continue;
    if (m.spreadPct !== null && m.spreadPct > s.maxSpreadPct) continue;
    if (s.requireExecutable && (m.executableEdgePct === null || m.executableEdgePct < s.minExecutableEdgePct))
      continue;

    const fundingRate = val(f.fundingRate);
    const lev = row.instrument?.maxLeverage;
    const data: FairPriceData = {
      exchange: row.exchange,
      symbol: row.symbol,
      asset: assetCode,
      url: row.instrument?.url ?? null,
      last,
      mark,
      index: val(f.index),
      indexKind: row.instrument?.indexKind ?? 'index',
      bid: val(f.bid),
      ask: val(f.ask),
      deviationPct: m.deviationPct,
      executableEdgePct: m.executableEdgePct,
      fairVsIndexPct: m.fairVsIndexPct,
      fairIndexWarning: m.fairVsIndexPct !== null && Math.abs(m.fairVsIndexPct) >= s.fairIndexWarnPct,
      spreadPct: m.spreadPct,
      topOfBookUsd: m.topOfBookUsd,
      turnover24h: turnover,
      fundingRate,
      fundingIntervalHours: val(f.fundingIntervalHours),
      nextFundingTime: val(f.nextFundingTime),
      maxLeverage: lev?.available ? lev.value : null,
      maxLeverageNote:
        lev && !lev.available
          ? lev.reason === 'requires_api_key'
            ? 'needs an API key'
            : 'not published'
          : null,
      quote: row.instrument?.quote ?? 'USDT',
      risk: assessRisk({
        deviationPct: m.deviationPct,
        spreadPct: m.spreadPct,
        topOfBookUsd: m.topOfBookUsd,
        fairVsIndexPct: m.fairVsIndexPct,
        fairIndexWarnPct: s.fairIndexWarnPct,
        fundingRate,
        turnover24h: turnover,
      }),
    };
    candidates.push({
      key: `${row.exchange}:${row.symbol}:${m.direction}`,
      exchange: row.exchange,
      symbol: row.symbol,
      asset: assetCode,
      direction: m.direction,
      value: m.deviationPct,
      title: `${m.direction} ${row.symbol} on ${exchangeName(row.exchange)}: market ${pct(m.deviationPct)} vs fair`,
      data,
    });
  }
  const warnings: string[] = [];
  if (view.staleExchanges.length > 0)
    warnings.push(`no fresh data from: ${view.staleExchanges.map(exchangeName).join(', ')}`);
  if (evaluated > 0 && missing / evaluated > 0.2)
    warnings.push(`${missing} of ${evaluated} instruments lack a fresh last or mark price`);
  return { candidates, evaluated, warnings };
}

export function formatFairPrice(
  signal: { data: Record<string, unknown> },
  status: Parameters<typeof footer>[0],
): string {
  const d = signal.data as FairPriceData;
  const long = d.deviationPct < 0;
  const head = `${long ? '🟢 <b>LONG</b>' : '🔴 <b>SHORT</b>'} · ${link(d.symbol, d.url)} · ${esc(exchangeName(d.exchange))}`;
  const indexLabel = d.indexKind === 'oracle' ? 'Oracle' : 'Index';
  const lines = [
    head,
    `Market <b>${price(d.last)}</b> vs fair <b>${price(d.mark)}</b> → <b>${pct(d.deviationPct)}</b>`,
    `Fair vs ${indexLabel.toLowerCase()} (${price(d.index)}): ${pct(d.fairVsIndexPct)}${d.fairIndexWarning ? ' ⚠️ fair price far from index' : ''}`,
    `Executable now: ${long ? `ask ${price(d.ask)}` : `bid ${price(d.bid)}`} (${pct(d.executableEdgePct)} edge vs fair)`,
    `Best-level liquidity ${usd(d.topOfBookUsd)} · spread ${pct(d.spreadPct)} · 24 h turnover ${usd(d.turnover24h)}`,
    `Funding ${rate(d.fundingRate)} / ${d.fundingIntervalHours ?? '—'} h${
      d.nextFundingTime
        ? ` · next in ${Math.max(0, Math.round((d.nextFundingTime - status.updatedAt) / 60_000))} min`
        : ''
    }`,
    `Max leverage: ${d.maxLeverage !== null ? `${d.maxLeverage}×` : (d.maxLeverageNote ?? '—')}`,
    `Risk: <b>${d.risk.level}</b>${d.risk.reasons.length ? ` (${esc(d.risk.reasons.join('; '))})` : ''}`,
    footer(status),
  ];
  return lines.join('\n');
}

export const fairPriceScanner: ScannerDefinition<FairPriceSettings> = {
  id: 'fair-price',
  intervalMs: 1_000,
  evaluate: (view, settings) => evaluateFairPrice(view, settings),
  format: formatFairPrice,
};
