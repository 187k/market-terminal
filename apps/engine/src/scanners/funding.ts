import { bestFundingPair, funding24h } from '@mip/analytics';
import type {
  ExchangeId,
  FundingData,
  FundingLegData,
  FundingSettlement as Settlement,
  FundingSettings,
} from '@mip/core';
import { duration, esc, exchangeName, footer, link, pct, price, rate, usd } from '../format.js';
import type { HistoryPoint, SnapshotHistory } from '../history.js';
import { val, type MarketView, type ViewRow } from '../view.js';
import {
  passesCommonFilters,
  type Candidate,
  type EvaluationResult,
  type ScannerDefinition,
} from './types.js';

export type { FundingData, FundingLegData, Settlement };

/**
 * The most recent settlement visible in the snapshot history: the point where the published
 * next-funding time moved forward. The rate just before it is the one that was applied,
 * assuming the live field is the estimate for the upcoming settlement (Stage 1, 3.4).
 */
export function lastSettlement(points: readonly HistoryPoint[]): Settlement | null {
  for (let i = points.length - 1; i > 0; i--) {
    const before = points[i - 1]!;
    const after = points[i]!;
    if (
      before.nextFundingTime !== null &&
      after.nextFundingTime !== null &&
      after.nextFundingTime > before.nextFundingTime &&
      before.fundingRate !== null
    ) {
      return { at: before.nextFundingTime, rate: before.fundingRate };
    }
  }
  return null;
}

function legOf(row: ViewRow, history: Pick<SnapshotHistory, 'series'>): FundingLegData | null {
  const f = row.fields;
  const r = val(f.fundingRate);
  const interval = val(f.fundingIntervalHours);
  if (r === null || interval === null) return null;
  const r24 = funding24h(r, interval);
  if (r24 === null) return null;
  return {
    exchange: row.exchange,
    symbol: row.symbol,
    url: row.instrument?.url ?? null,
    quote: row.instrument?.quote ?? 'USDT',
    rate: r,
    intervalHours: interval,
    rate24h: r24,
    nextFundingTime: val(f.nextFundingTime),
    lastSettled: lastSettlement(history.series(row.exchange, row.symbol)),
    mark: val(f.mark),
    turnover24h: val(f.turnover24h),
  };
}

export function evaluateFunding(
  view: MarketView,
  s: FundingSettings,
  history: Pick<SnapshotHistory, 'series'>,
): EvaluationResult {
  const candidates: Candidate[] = [];
  let evaluated = 0;
  for (const [assetId, rows] of view.byAsset) {
    const assetCode = rows[0]?.asset?.symbol ?? assetId;
    if (!passesCommonFilters(s, null, assetCode)) continue;
    const legs = rows
      .filter((r) => s.exchanges.length === 0 || s.exchanges.includes(r.exchange))
      .filter((r) => {
        const t = val(r.fields.turnover24h);
        return s.minTurnover24hUsd <= 0 || (t !== null && t >= s.minTurnover24hUsd);
      })
      .map((r) => legOf(r, history))
      .filter((l): l is FundingLegData => l !== null)
      .sort((a, b) => b.rate24h - a.rate24h);
    if (legs.length === 0) continue;
    evaluated++;

    if (s.signalExtremes) {
      for (const leg of legs) {
        if (Math.abs(leg.rate24h) * 100 < s.extreme24hPct) continue;
        const sign = leg.rate24h > 0 ? 'POSITIVE' : 'NEGATIVE';
        candidates.push({
          key: `extreme:${leg.exchange}:${leg.symbol}:${sign}`,
          exchange: leg.exchange,
          symbol: leg.symbol,
          asset: assetCode,
          direction: sign,
          value: leg.rate24h * 100,
          title: `Extreme funding ${pct(leg.rate24h * 100, 3)}/24h · ${leg.symbol} on ${exchangeName(leg.exchange)}`,
          data: { kind: 'extreme', asset: assetCode, legs, leg } satisfies FundingData,
        });
      }
    }

    if (s.signalArbitrage) {
      const pair = bestFundingPair(legs.map((l) => ({ ...l, key: l.exchange })));
      if (pair && pair.difference24h * 100 >= s.minDifference24hPct) {
        candidates.push({
          key: `arb:${assetId}:${pair.long.exchange}:${pair.short.exchange}`,
          exchange: null,
          symbol: null,
          asset: assetCode,
          direction: `LONG ${pair.long.exchange} / SHORT ${pair.short.exchange}`,
          value: pair.difference24h * 100,
          title: `${assetCode}: funding spread ${pct(pair.difference24h * 100, 3)}/24h (long ${exchangeName(pair.long.exchange)}, short ${exchangeName(pair.short.exchange)})`,
          data: {
            kind: 'arbitrage',
            asset: assetCode,
            legs,
            long: pair.long,
            short: pair.short,
            difference24h: pair.difference24h,
            mixedQuotes: pair.long.quote !== pair.short.quote,
          } satisfies FundingData,
        });
      }
    }
  }
  return { candidates, evaluated, warnings: [] };
}

function legLine(l: FundingLegData, now: number): string {
  const next = l.nextFundingTime ? ` · next in ${duration(l.nextFundingTime - now)}` : '';
  const settled = l.lastSettled ? ` · last settled ${rate(l.lastSettled.rate)}` : '';
  return `${link(exchangeName(l.exchange), l.url)}: ${rate(l.rate)} / ${l.intervalHours} h → <b>${pct(l.rate24h * 100, 3)}</b>/24h${next}${settled}`;
}

export function formatFunding(
  signal: { data: Record<string, unknown> },
  status: Parameters<typeof footer>[0],
): string {
  const d = signal.data as FundingData;
  const now = status.updatedAt;
  const lines: string[] = [];
  if (d.kind === 'extreme' && d.leg) {
    const l = d.leg;
    lines.push(
      `🔥 <b>Extreme funding</b> · ${link(l.symbol, l.url)} · ${esc(exchangeName(l.exchange))}`,
      `Current (estimate for the next settlement): ${rate(l.rate)} / ${l.intervalHours} h → <b>${pct(l.rate24h * 100, 3)}</b> per 24 h`,
      `Last settled: ${l.lastSettled ? `${rate(l.lastSettled.rate)} (observed before the settlement at ${new Date(l.lastSettled.at).toISOString().slice(11, 16)} UTC)` : 'not observed yet'}`,
      `Next settlement in ${l.nextFundingTime ? duration(l.nextFundingTime - now) : '—'} · mark ${price(l.mark)} · 24 h turnover ${usd(l.turnover24h)}`,
      `${l.rate24h > 0 ? 'Longs pay shorts.' : 'Shorts pay longs.'}`,
    );
  } else if (d.long && d.short && d.difference24h !== undefined) {
    lines.push(
      `⚖️ <b>Funding spread</b> · ${esc(d.asset)} · <b>${pct(d.difference24h * 100, 3)}</b> per 24 h`,
      `Long ${esc(exchangeName(d.long.exchange))} (${pct(d.long.rate24h * 100, 3)}/24h) · short ${esc(exchangeName(d.short.exchange))} (${pct(d.short.rate24h * 100, 3)}/24h)`,
      `≈ ${usd(d.difference24h * 10_000)} per day on $10k notional per leg, before fees and price moves`,
      d.long.intervalHours !== d.short.intervalHours
        ? `⚠️ Legs settle on different schedules (every ${d.long.intervalHours} h vs every ${d.short.intervalHours} h).`
        : '',
      d.mixedQuotes ? `⚠️ Different quote currencies (${esc(d.long.quote)} vs ${esc(d.short.quote)}).` : '',
    );
  }
  lines.push('<b>All exchanges</b>', ...d.legs.map((l) => legLine(l, now)));
  lines.push('<i>Current rates are estimates until settlement.</i>', footer(status));
  return lines.filter(Boolean).join('\n');
}

export function createFundingScanner(history: SnapshotHistory): ScannerDefinition<FundingSettings> {
  return {
    id: 'funding',
    intervalMs: 15_000,
    evaluate: (view, settings) => evaluateFunding(view, settings, history),
    format: formatFunding,
  };
}
