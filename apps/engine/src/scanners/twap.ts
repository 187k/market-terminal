import { coefficientOfVariation, median, pctDiff } from '@mip/analytics';
import { isZeroHash } from '@mip/connectors';
import type { ExchangeId, TradeEvent, TwapData, TwapSettings } from '@mip/core';
import { compact, duration, esc, exchangeName, footer, link, pct, price, usd, utcTime } from '../format.js';
import type { HlTwapWatcher, TwapOrder } from '../hl-twap.js';
import type { TradeBuffer } from '../trades.js';
import { val, type MarketView } from '../view.js';
import {
  passesCommonFilters,
  type Candidate,
  type EvaluationResult,
  type ScannerDefinition,
} from './types.js';

export type { TwapData };

/** One taker order: fills at the same time on the same side merged (VWAP price, summed size). */
export interface Execution {
  ts: number;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  notional: number;
}

export function toExecutions(trades: readonly TradeEvent[]): Execution[] {
  const out: Execution[] = [];
  for (const t of trades) {
    const prev = out[out.length - 1];
    if (prev && prev.ts === t.ts && prev.side === t.side) {
      prev.notional += t.price * t.size;
      prev.size += t.size;
      prev.price = prev.notional / prev.size;
    } else {
      out.push({ ts: t.ts, side: t.side, price: t.price, size: t.size, notional: t.price * t.size });
    }
  }
  return out;
}

export interface PatternStats {
  side: 'buy' | 'sell';
  slices: number;
  firstTs: number;
  lastTs: number;
  executedNotional: number;
  executedQty: number;
  vwap: number;
  firstPrice: number;
  medianIntervalMs: number;
  /** Coefficient of variation of the time between executions (0 = perfectly regular). */
  cvInterval: number;
  /** Coefficient of variation of execution sizes. */
  cvSize: number;
  /** (this side − other side) / total notional in the window, clipped at 0. */
  oneSided: number;
  confidence: number;
  status: 'active' | 'completed';
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Heuristic: the largest group of similar-size executions on one side. Scored by regular
 * timing (40 %), similar sizes (20 %), number of executions (20 %) and one-sidedness of the
 * window's volume (20 %). Not proof of a TWAP: retail flow at a common lot size can look alike,
 * which the timing regularity is there to separate.
 */
export function findPattern(
  executions: readonly Execution[],
  side: 'buy' | 'sell',
  s: Pick<TwapSettings, 'minSlices' | 'minDurationSec' | 'sizeTolerancePct'>,
  now: number,
): PatternStats | null {
  const same = executions.filter((e) => e.side === side);
  if (same.length < s.minSlices) return null;
  const step = Math.log(1 + s.sizeTolerancePct / 100);
  const bins = new Map<number, Execution[]>();
  for (const e of same) {
    const k = Math.floor(Math.log(e.size) / step);
    bins.set(k, [...(bins.get(k) ?? []), e]);
  }
  let best: Execution[] = [];
  for (const k of bins.keys()) {
    const group = [...(bins.get(k) ?? []), ...(bins.get(k + 1) ?? [])];
    if (group.length > best.length) best = group;
  }
  if (best.length < s.minSlices) return null;
  best.sort((a, b) => a.ts - b.ts);
  const firstTs = best[0]!.ts;
  const lastTs = best[best.length - 1]!.ts;
  if (lastTs - firstTs < s.minDurationSec * 1000) return null;
  const intervals = best.slice(1).map((e, i) => e.ts - best[i]!.ts);
  const sizes = best.map((e) => e.size);
  const executedNotional = best.reduce((n, e) => n + e.notional, 0);
  const executedQty = best.reduce((n, e) => n + e.size, 0);
  const sideNotional = same.reduce((n, e) => n + e.notional, 0);
  const otherNotional = executions.filter((e) => e.side !== side).reduce((n, e) => n + e.notional, 0);
  const cvInterval = coefficientOfVariation(intervals) ?? 1;
  const cvSize = coefficientOfVariation(sizes) ?? 0;
  const oneSided = clamp01((sideNotional - otherNotional) / Math.max(sideNotional + otherNotional, 1e-9));
  const regularity = clamp01(1 - cvInterval);
  const similarity = clamp01(1 - cvSize / ((2 * s.sizeTolerancePct) / 100));
  const count = clamp01(best.length / (3 * s.minSlices));
  const medianIntervalMs = median(intervals) ?? 0;
  return {
    side,
    slices: best.length,
    firstTs,
    lastTs,
    executedNotional,
    executedQty,
    vwap: executedNotional / executedQty,
    firstPrice: best[0]!.price,
    medianIntervalMs,
    cvInterval,
    cvSize,
    oneSided,
    confidence: 0.4 * regularity + 0.2 * similarity + 0.2 * count + 0.2 * oneSided,
    status: now - lastTs <= Math.max(3 * medianIntervalMs, 60_000) ? 'active' : 'completed',
  };
}

/** Hyperliquid TWAP slices grouped per wallet: the TWAP owner is the taker (buyer for "buy"). */
export interface ConfirmedGroup {
  wallet: string;
  side: 'buy' | 'sell';
  executions: Execution[];
}

export function confirmedGroups(trades: readonly TradeEvent[]): ConfirmedGroup[] {
  const groups = new Map<string, { wallet: string; side: 'buy' | 'sell'; trades: TradeEvent[] }>();
  for (const t of trades) {
    if (!isZeroHash(t.hash) || !t.users) continue;
    const wallet = (t.side === 'buy' ? t.users[0] : t.users[1]).toLowerCase();
    const key = `${wallet}:${t.side}`;
    const g = groups.get(key) ?? { wallet, side: t.side, trades: [] };
    g.trades.push(t);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    wallet: g.wallet,
    side: g.side,
    executions: toExecutions(g.trades),
  }));
}

/** Per-exchange caveats on what one "trade" is. */
const TRADE_NOTES: Partial<Record<ExchangeId, string>> = {
  binance:
    'Binance publishes aggregated trades (same price and side within 100 ms), so one execution may be several fills',
  mexc: 'MEXC deals are aggregated by default',
};

const orderStatus = (o: TwapOrder | undefined): TwapData['status'] =>
  !o
    ? 'unknown'
    : o.status === 'activated'
      ? 'active'
      : o.status === 'finished'
        ? 'completed'
        : o.status === 'terminated'
          ? 'cancelled'
          : 'unknown';

export function evaluateTwap(
  view: MarketView,
  s: TwapSettings,
  buffer: Pick<TradeBuffer, 'get'>,
  watcher: Pick<HlTwapWatcher, 'watch' | 'orders'> | null,
  now: number,
): EvaluationResult {
  const candidates: Candidate[] = [];
  let evaluated = 0;
  const since = now - s.windowMinutes * 60_000;
  for (const row of view.rows) {
    const assetCode = row.asset?.symbol ?? row.instrument?.asset ?? row.symbol;
    if (!passesCommonFilters(s, row.exchange, assetCode)) continue;
    const trades = buffer.get(row.exchange, row.symbol).filter((t) => t.ts >= since);
    if (trades.length === 0) continue;
    evaluated++;
    const turnover = val(row.fields.turnover24h);
    if (s.minTurnover24hUsd > 0 && (turnover === null || turnover < s.minTurnover24hUsd)) continue;
    const priceNow = val(row.fields.mark) ?? val(row.fields.last);
    const common = {
      exchange: row.exchange,
      symbol: row.symbol,
      asset: assetCode,
      url: row.instrument?.url ?? null,
      priceNow,
      marketCapUsd: row.asset?.marketCapUsd ?? null,
      turnover24h: turnover,
    };

    if (row.exchange === 'hyperliquid' && s.hyperliquidConfirmed) {
      for (const g of confirmedGroups(trades)) {
        const notional = g.executions.reduce((n, e) => n + e.notional, 0);
        if (notional < s.minNotionalUsd) continue;
        watcher?.watch(g.wallet, now);
        const orders = watcher?.orders(g.wallet) ?? null;
        const hlSide = g.side === 'buy' ? 'B' : 'A';
        const order = orders
          ?.filter((o) => o.coin === row.symbol && o.side === hlSide)
          .sort((a, b) => b.startedAt - a.startedAt)[0];
        const qty = g.executions.reduce((n, e) => n + e.size, 0);
        const first = g.executions[0]!;
        // userTwapHistory entries are status changes: the "activated" entry carries the executed
        // size at activation (0). Final figures exist only once the order finished or stopped.
        const final = order !== undefined && order.status !== 'activated' && order.executedSz > 0;
        const elapsedPct =
          order && order.status === 'activated' && order.minutes > 0
            ? Math.min(100, ((now - order.startedAt) / (order.minutes * 60_000)) * 100)
            : null;
        const data: TwapData = {
          ...common,
          kind: 'confirmed',
          label: 'exchange-confirmed (Hyperliquid TWAP slices, zero transaction hash)',
          side: g.side === 'buy' ? 'BUY' : 'SELL',
          status: order ? orderStatus(order) : 'unknown',
          slices: g.executions.length,
          firstTs: first.ts,
          lastTs: g.executions[g.executions.length - 1]!.ts,
          executedNotional: final ? order.executedNtl : notional,
          executedQty: final ? order.executedSz : qty,
          executedSource: final ? 'exchange' : 'observed',
          vwap: notional / qty,
          priceChangePct: priceNow === null ? null : pctDiff(priceNow, first.price),
          orderNotional: order && priceNow !== null ? order.sz * priceNow : null,
          executedPct: final && order.sz > 0 ? (order.executedSz / order.sz) * 100 : null,
          elapsedPct,
          confidence: null,
          wallet: g.wallet,
          twap: order
            ? {
                minutes: order.minutes,
                randomize: order.randomize,
                reduceOnly: order.reduceOnly,
                startedAt: order.startedAt,
              }
            : null,
          walletTwapCount: orders ? orders.length : null,
          metrics: { cvInterval: null, cvSize: null, medianIntervalMs: null, oneSided: null },
          note: orders === null ? 'TWAP order details requested from Hyperliquid; not received yet' : null,
        };
        candidates.push({
          key: `hl:${g.wallet}:${row.symbol}:${data.side}`,
          exchange: row.exchange,
          symbol: row.symbol,
          asset: assetCode,
          direction: data.side,
          value: data.executedNotional,
          title: `TWAP (confirmed) ${data.side} ${row.symbol} on Hyperliquid · ${usd(data.executedNotional)} executed${data.executedPct !== null ? ` (${data.executedPct.toFixed(0)} %)` : ''} · wallet ${g.wallet.slice(0, 6)}…${g.wallet.slice(-4)}`,
          data,
        });
      }
    }

    const executions = toExecutions(trades);
    for (const side of ['buy', 'sell'] as const) {
      const p = findPattern(executions, side, s, now);
      if (!p || p.executedNotional < s.minNotionalUsd || p.confidence < s.minConfidence) continue;
      const data: TwapData = {
        ...common,
        kind: 'heuristic',
        label: 'algorithmic assumption (heuristic pattern, not confirmed by the exchange)',
        side: side === 'buy' ? 'BUY' : 'SELL',
        status: p.status,
        slices: p.slices,
        firstTs: p.firstTs,
        lastTs: p.lastTs,
        executedNotional: p.executedNotional,
        executedQty: p.executedQty,
        vwap: p.vwap,
        priceChangePct: priceNow === null ? null : pctDiff(priceNow, p.firstPrice),
        orderNotional: p.executedNotional,
        executedPct: null,
        elapsedPct: null,
        executedSource: 'observed',
        confidence: p.confidence,
        wallet: null,
        twap: null,
        walletTwapCount: null,
        metrics: {
          cvInterval: p.cvInterval,
          cvSize: p.cvSize,
          medianIntervalMs: p.medianIntervalMs,
          oneSided: p.oneSided,
        },
        note: TRADE_NOTES[row.exchange] ?? null,
      };
      candidates.push({
        key: `${row.exchange}:${row.symbol}:${data.side}`,
        exchange: row.exchange,
        symbol: row.symbol,
        asset: assetCode,
        direction: data.side,
        value: p.executedNotional,
        title: `TWAP? ${data.side} ${row.symbol} on ${exchangeName(row.exchange)} · ${usd(p.executedNotional)} in ${p.slices} executions · confidence ${(p.confidence * 100).toFixed(0)} %`,
        data,
      });
    }
  }
  return { candidates, evaluated, warnings: [] };
}

export function formatTwap(
  signal: { data: Record<string, unknown> },
  status: Parameters<typeof footer>[0],
): string {
  const d = signal.data as TwapData;
  const confirmed = d.kind === 'confirmed';
  return [
    `${d.side === 'BUY' ? '🟢' : '🔴'} <b>${confirmed ? 'TWAP (exchange-confirmed)' : 'Possible TWAP / DCA'}</b> · <b>${d.side}</b> · ${link(d.symbol, d.url)} · ${esc(exchangeName(d.exchange))}`,
    `<i>${esc(d.label)}</i>`,
    confirmed
      ? `Order: <b>${d.orderNotional !== null ? usd(d.orderNotional) : 'size not received yet'}</b> · ${
          d.executedSource === 'exchange'
            ? `executed ${usd(d.executedNotional)}${d.executedPct !== null ? ` (${d.executedPct.toFixed(1)} %, reported by Hyperliquid)` : ''}`
            : `observed ${usd(d.executedNotional)} in ${d.slices} slices since monitoring started`
        }${d.elapsedPct !== null ? ` · ${d.elapsedPct.toFixed(0)} % of its scheduled time elapsed` : ''}`
      : `Executed so far (estimated order size, lower bound): <b>${usd(d.executedNotional)}</b> in ${d.slices} executions · confidence <b>${((d.confidence ?? 0) * 100).toFixed(0)} %</b>`,
    `Status: <b>${d.status}</b> · ${duration(d.lastTs - d.firstTs)} so far (${utcTime(d.firstTs)} → ${utcTime(d.lastTs)})`,
    d.twap
      ? `TWAP setting: ${d.twap.minutes} min${d.twap.randomize ? ', randomised' : ''}${d.twap.reduceOnly ? ', reduce-only' : ''}`
      : '',
    `Average execution price ${price(d.vwap)} (${compact(d.executedQty)} ${esc(d.asset)}) · price change since start ${pct(d.priceChangePct)}`,
    d.wallet
      ? `Wallet: <code>${esc(d.wallet)}</code>${d.walletTwapCount !== null ? ` · ${d.walletTwapCount} TWAP order${d.walletTwapCount === 1 ? '' : 's'} in its history` : ''}`
      : 'Wallet / participant history: not available on this exchange',
    `Market cap ${usd(d.marketCapUsd)} · 24 h turnover ${usd(d.turnover24h)}`,
    !confirmed && d.metrics.medianIntervalMs !== null
      ? `Pattern: every ~${Math.round(d.metrics.medianIntervalMs / 1000)} s (timing CV ${d.metrics.cvInterval?.toFixed(2)}, size CV ${d.metrics.cvSize?.toFixed(2)}, one-sided ${((d.metrics.oneSided ?? 0) * 100).toFixed(0)} %)`
      : '',
    d.note ? `<i>Note: ${esc(d.note)}.</i>` : '',
    footer(status),
  ]
    .filter(Boolean)
    .join('\n');
}

export function createTwapScanner(
  buffer: TradeBuffer,
  watcher: HlTwapWatcher | null,
): ScannerDefinition<TwapSettings> {
  return {
    id: 'twap',
    intervalMs: 15_000,
    evaluate(view, settings, now) {
      buffer.setWindow(settings.windowMinutes * 60_000);
      buffer.trim(now);
      return evaluateTwap(view, settings, buffer, watcher, now);
    },
    format: formatTwap,
  };
}
