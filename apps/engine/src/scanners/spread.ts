import { funding24h, grossSpreadPct, mean, profit, vwap } from '@mip/analytics';
import type { ExchangeId, Field, SpreadData, SpreadExecution, SpreadLeg, SpreadSettings } from '@mip/core';
import { esc, exchangeName, footer, link, pct, price, rate, usd } from '../format.js';
import { val, type MarketView, type ViewRow } from '../view.js';
import {
  passesCommonFilters,
  type Candidate,
  type EvaluationResult,
  type ScannerDefinition,
} from './types.js';

export type { SpreadData, SpreadExecution, SpreadLeg };

/** Order-book access for VWAP; the engine passes a rate-limited, cached REST fetcher. */
export interface DepthSource {
  fetch(
    exchange: ExchangeId,
    symbol: string,
    contractSize: number,
  ): Promise<{ bids: [number, number][]; asks: [number, number][] }>;
}

const fieldTs = (f: Field<number>) => (f.available ? f.ts : 0);

export function legOf(row: ViewRow): SpreadLeg | null {
  const f = row.fields;
  const bid = val(f.bid);
  const ask = val(f.ask);
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || bid >= ask) return null;
  const m = row.instrument?.multiplier ?? 1;
  const rateV = val(f.fundingRate);
  const interval = val(f.fundingIntervalHours);
  const bs = val(f.bidSize);
  const as = val(f.askSize);
  return {
    exchange: row.exchange,
    symbol: row.symbol,
    url: row.instrument?.url ?? null,
    quote: row.instrument?.quote ?? 'USDT',
    multiplier: m,
    contractSize: row.instrument?.contractSize ?? 1,
    bid: bid / m,
    ask: ask / m,
    rawBid: bid,
    rawAsk: ask,
    bidSizeAsset: bs === null ? null : bs * m,
    askSizeAsset: as === null ? null : as * m,
    mark: val(f.mark),
    index: val(f.index),
    indexKind: row.instrument?.indexKind ?? 'index',
    fundingRate: rateV,
    fundingIntervalHours: interval,
    funding24h: rateV !== null && interval !== null ? funding24h(rateV, interval) : null,
    turnover24h: val(f.turnover24h),
    quoteTs: Math.min(fieldTs(f.bid), fieldTs(f.ask)),
  };
}

/** Best ordered pair (buy at the lowest ask, sell at the highest bid) on two different exchanges. */
export function bestPair(
  legs: SpreadLeg[],
  allowMixedQuotes: boolean,
): { buy: SpreadLeg; sell: SpreadLeg; grossPct: number } | null {
  let best: { buy: SpreadLeg; sell: SpreadLeg; grossPct: number } | null = null;
  for (const buy of legs)
    for (const sell of legs) {
      if (buy.exchange === sell.exchange) continue;
      if (!allowMixedQuotes && buy.quote !== sell.quote) continue;
      const g = grossSpreadPct(buy.ask, sell.bid);
      if (g !== null && (!best || g > best.grossPct)) best = { buy, sell, grossPct: g };
    }
  return best;
}

async function execute(
  depth: DepthSource,
  buy: SpreadLeg,
  sell: SpreadLeg,
  qty: number,
): Promise<SpreadExecution> {
  try {
    const [bb, sb] = await Promise.all([
      depth.fetch(buy.exchange, buy.symbol, buy.contractSize),
      depth.fetch(sell.exchange, sell.symbol, sell.contractSize),
    ]);
    // Books are per base unit of each contract: convert the asset quantity, then back to asset prices.
    const b = vwap(bb.asks, qty / buy.multiplier);
    const s = vwap(sb.bids, qty / sell.multiplier);
    const buyVwap = b ? b.vwap / buy.multiplier : null;
    const sellVwap = s ? s.vwap / sell.multiplier : null;
    return {
      buyVwap,
      sellVwap,
      buyComplete: b?.complete ?? false,
      sellComplete: s?.complete ?? false,
      buySlippagePct: buyVwap === null ? null : ((buyVwap - buy.ask) / buy.ask) * 100,
      sellSlippagePct: sellVwap === null ? null : ((sell.bid - sellVwap) / sell.bid) * 100,
      error: null,
    };
  } catch (err) {
    return {
      buyVwap: null,
      sellVwap: null,
      buyComplete: false,
      sellComplete: false,
      buySlippagePct: null,
      sellSlippagePct: null,
      error: (err as Error).message,
    };
  }
}

export async function evaluateSpread(
  view: MarketView,
  s: SpreadSettings,
  depth: DepthSource,
): Promise<EvaluationResult> {
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  let evaluated = 0;
  for (const [assetId, rows] of view.byAsset) {
    const assetCode = rows[0]?.asset?.symbol ?? assetId;
    if (!passesCommonFilters(s, null, assetCode)) continue;
    const legs = rows
      .filter((r) => s.exchanges.length === 0 || s.exchanges.includes(r.exchange))
      .map(legOf)
      .filter((l): l is SpreadLeg => l !== null)
      .filter(
        (l) => s.minTurnover24hUsd <= 0 || (l.turnover24h !== null && l.turnover24h >= s.minTurnover24hUsd),
      );
    if (legs.length < 2) continue;
    evaluated++;
    const pair = bestPair(legs, s.allowMixedQuotes);
    if (!pair || pair.grossPct < s.minGrossSpreadPct) continue;
    const { buy, sell, grossPct } = pair;
    if (grossPct > s.maxPlausibleSpreadPct) {
      warnings.push(
        `${assetCode}: ${grossPct.toFixed(2)} % gap between ${exchangeName(buy.exchange)} and ${exchangeName(sell.exchange)} quarantined as a probable mapping problem`,
      );
      continue;
    }
    if (Math.abs(buy.quoteTs - sell.quoteTs) > s.maxQuoteSkewMs) continue;

    const qty = s.positionUsd / buy.ask;
    const execution = await execute(depth, buy, sell, qty);
    const preliminary: string[] = [];
    if (execution.error)
      preliminary.push(`order book unavailable (${execution.error}); top-of-book prices used`);
    else if (!execution.buyComplete || !execution.sellComplete)
      preliminary.push('visible order book thinner than the position; VWAP covers part of it');
    const buyPrice = execution.buyVwap ?? buy.ask;
    const sellPrice = execution.sellVwap ?? sell.bid;
    const buyFeeRate = s.takerFees[buy.exchange];
    const sellFeeRate = s.takerFees[sell.exchange];
    preliminary.push('fees are default taker rates (configurable), not your account tier');
    let fundingCost = 0;
    if (s.holdingHours > 0) {
      if (buy.funding24h === null || sell.funding24h === null)
        preliminary.push('funding not included (rate unavailable)');
      else fundingCost = s.positionUsd * (buy.funding24h - sell.funding24h) * (s.holdingHours / 24);
    }
    const breakdown = profit({ qty, buyPrice, sellPrice, buyFeeRate, sellFeeRate, fundingCost });
    if (breakdown.netPct < s.minNetSpreadPct) continue;

    const mids = legs.map((l) => (l.bid + l.ask) / 2);
    const averagePrice = mean(mids)!;
    const compatibility = [
      'both perpetual contracts (linear)',
      buy.multiplier !== sell.multiplier
        ? `contract units differ (${buy.multiplier}× vs ${sell.multiplier}×); prices normalised per asset unit`
        : 'same contract unit',
      buy.quote === sell.quote
        ? `same quote currency (${buy.quote})`
        : `different quote currencies (${buy.quote} vs ${sell.quote})`,
      `price check passed (gap below ${s.maxPlausibleSpreadPct} %)`,
    ];
    const reasons: string[] = [];
    if (preliminary.some((p) => p.startsWith('order book') || p.startsWith('visible')))
      reasons.push('depth incomplete');
    if (buy.quote !== sell.quote) reasons.push('USDT/USDC basis not included');
    if (grossPct > 2) reasons.push('unusually large gap: check both markets before acting');
    if ((buy.turnover24h ?? 0) < 5e6 || (sell.turnover24h ?? 0) < 5e6) reasons.push('low volume on one leg');
    if (fundingCost > 0) reasons.push('funding works against the position');
    const data: SpreadData = {
      asset: assetCode,
      buy,
      sell,
      legs,
      grossPct,
      netPct: breakdown.netPct,
      positionUsd: s.positionUsd,
      qty,
      breakdown,
      buyFeeRate,
      sellFeeRate,
      holdingHours: s.holdingHours,
      execution,
      averagePrice,
      deviations: legs.map((l, i) => ({
        exchange: l.exchange,
        pct: ((mids[i]! - averagePrice) / averagePrice) * 100,
      })),
      preliminary,
      compatibility,
      risk: { level: reasons.length >= 3 ? 'high' : reasons.length === 2 ? 'medium' : 'low', reasons },
    };
    candidates.push({
      key: `${assetId}:${buy.exchange}:${sell.exchange}`,
      exchange: null,
      symbol: null,
      asset: assetCode,
      direction: `BUY ${buy.exchange} / SELL ${sell.exchange}`,
      value: breakdown.netPct,
      title: `${assetCode}: buy ${exchangeName(buy.exchange)}, sell ${exchangeName(sell.exchange)} · gross ${pct(grossPct)} · net ${pct(breakdown.netPct)}`,
      data,
    });
  }
  return { candidates, evaluated, warnings };
}

export function formatSpread(
  signal: { data: Record<string, unknown> },
  status: Parameters<typeof footer>[0],
): string {
  const d = signal.data as SpreadData;
  const b = d.breakdown;
  const leg = (l: SpreadLeg) =>
    `${link(exchangeName(l.exchange), l.url)} ${esc(l.symbol)}: bid ${price(l.bid)} / ask ${price(l.ask)} · mark ${price(l.mark)} · ${l.indexKind} ${price(l.index)} · funding ${rate(l.fundingRate)}/${l.fundingIntervalHours ?? '—'}h (${pct(l.funding24h === null ? null : l.funding24h * 100, 3)}/24h) · 24h ${usd(l.turnover24h)}`;
  return [
    `↔️ <b>${esc(d.asset)}</b> · net <b>${pct(d.netPct)}</b> (gross ${pct(d.grossPct)})`,
    `🟢 BUY / LONG on <b>${esc(exchangeName(d.buy.exchange))}</b> at ${price(d.execution.buyVwap ?? d.buy.ask)}${d.execution.buyVwap !== null ? ' (VWAP)' : ''}`,
    `🔴 SELL / SHORT on <b>${esc(exchangeName(d.sell.exchange))}</b> at ${price(d.execution.sellVwap ?? d.sell.bid)}${d.execution.sellVwap !== null ? ' (VWAP)' : ''}`,
    `Position ${usd(d.positionUsd)} (${d.qty.toPrecision(4)} ${esc(d.asset)}): cost ${usd(b.purchaseCost)}, proceeds ${usd(b.saleProceeds)}, gross ${usd(b.grossProfit)}`,
    `− fees ${usd(b.fees)} (${(d.buyFeeRate * 100).toFixed(3)} % + ${(d.sellFeeRate * 100).toFixed(3)} %) − funding over ${d.holdingHours} h ${b.fundingCost >= 0 ? usd(b.fundingCost) : `−${usd(b.fundingCost)} (credit)`} = <b>${b.netProfit >= 0 ? '' : '−'}${usd(b.netProfit)}</b>`,
    `Slippage: buy ${pct(d.execution.buySlippagePct)}, sell ${pct(d.execution.sellSlippagePct)} · average price ${price(d.averagePrice)}`,
    '<b>Legs</b>',
    leg(d.buy),
    leg(d.sell),
    `Deviation from average: ${d.deviations.map((x) => `${esc(exchangeName(x.exchange))} ${pct(x.pct, 3)}`).join(', ')}`,
    `Compatibility: ${esc(d.compatibility.join('; '))}`,
    'Deposit / withdrawal: not needed for a perp–perp position (margin on both exchanges).',
    d.preliminary.length ? `⚠️ <b>Preliminary</b>: ${esc(d.preliminary.join('; '))}` : '',
    `Risk: <b>${d.risk.level}</b>${d.risk.reasons.length ? ` (${esc(d.risk.reasons.join('; '))})` : ''}`,
    '<i>A perp–perp spread is a basis position, not a risk-free transfer.</i>',
    footer(status),
  ]
    .filter(Boolean)
    .join('\n');
}

export function createSpreadScanner(depth: DepthSource): ScannerDefinition<SpreadSettings> {
  return {
    id: 'spread',
    intervalMs: 2_000,
    evaluate: (view, settings) => evaluateSpread(view, settings, depth),
    format: formatSpread,
  };
}
