import { createHmac } from 'node:crypto';
import { available, unavailable, type InstrumentInfo, type MarketField, type TradeEvent } from '@mip/core';
import { num, putNumbers, splitBase } from '../base/symbols.js';

export interface BinanceSymbol {
  symbol: string;
  contractType: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  underlyingType: string;
  onboardDate?: number;
  filters?: { filterType: string; tickSize?: string }[];
}

/**
 * Crypto USDT-margined perpetuals only. `contractType` TRADIFI_PERPETUAL and `underlyingType`
 * EQUITY / COMMODITY / FX / INDEX / PREMARKET are excluded.
 */
export function isCryptoUsdtPerp(s: BinanceSymbol): boolean {
  return (
    s.contractType === 'PERPETUAL' &&
    s.status === 'TRADING' &&
    s.quoteAsset === 'USDT' &&
    s.marginAsset === 'USDT' &&
    s.underlyingType === 'COIN'
  );
}

export function toInstrument(
  s: BinanceSymbol,
  maxLeverage: number | undefined,
  haveKey: boolean,
): InstrumentInfo {
  const { asset, multiplier } = splitBase(s.baseAsset);
  const tick = s.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
  return {
    exchange: 'binance',
    symbol: s.symbol,
    base: s.baseAsset,
    asset,
    multiplier,
    quote: s.quoteAsset,
    contractSize: 1,
    tickSize: num(tick) ?? null,
    maxLeverage:
      maxLeverage !== undefined
        ? available(maxLeverage, Date.now())
        : haveKey
          ? unavailable('error', 'leverage brackets could not be loaded')
          : unavailable('requires_api_key', 'GET /fapi/v1/leverageBracket needs a read-only API key'),
    indexKind: 'index',
    launchTime: s.onboardDate ?? null,
    url: `https://www.binance.com/en/futures/${s.symbol}`,
  };
}

/**
 * `fundingInfo` lists only symbols whose funding settings were adjusted (Binance docs); every
 * other symbol uses the default 8 h interval.
 */
export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

export function fundingIntervals(
  rows: { symbol: string; fundingIntervalHours?: number }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const h = num(r.fundingIntervalHours);
    if (h !== undefined) map.set(r.symbol, h);
  }
  return map;
}

/** REST `premiumIndex` row. `lastFundingRate` is the live rate for the upcoming settlement. */
export function parsePremiumIndex(r: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['mark', r.markPrice],
    ['index', r.indexPrice],
    ['fundingRate', r.lastFundingRate],
    ['nextFundingTime', r.nextFundingTime],
  ]);
}

export function parseTicker24h(r: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['last', r.lastPrice],
    ['turnover24h', r.quoteVolume],
  ]);
}

export function parseBookTicker(r: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['bid', r.bidPrice],
    ['bidSize', r.bidQty],
    ['ask', r.askPrice],
    ['askSize', r.askQty],
  ]);
}

/** WS event payloads (`data` of a combined-stream message). */
export function parseStreamEvent(
  d: Record<string, unknown>,
): { symbol: string; ts: number | null; values: Partial<Record<MarketField, number>> } | null {
  const symbol = typeof d.s === 'string' ? d.s : null;
  if (!symbol) return null;
  const ts = num(d.E) ?? null;
  switch (d.e) {
    case 'depthUpdate': {
      // Partial book depth (top 5): snapshot of the best levels; [price, qty] pairs.
      const bid = Array.isArray(d.b) ? (d.b[0] as unknown[] | undefined) : undefined;
      const ask = Array.isArray(d.a) ? (d.a[0] as unknown[] | undefined) : undefined;
      return {
        symbol,
        ts,
        values: putNumbers<MarketField>({}, [
          ['bid', bid?.[0]],
          ['bidSize', bid?.[1]],
          ['ask', ask?.[0]],
          ['askSize', ask?.[1]],
        ]),
      };
    }
    case 'markPriceUpdate':
      return {
        symbol,
        ts,
        values: putNumbers<MarketField>({}, [
          ['mark', d.p],
          ['index', d.i],
          ['fundingRate', d.r],
          ['nextFundingTime', d.T],
        ]),
      };
    case '24hrTicker':
      return {
        symbol,
        ts,
        values: putNumbers<MarketField>({}, [
          ['last', d.c],
          ['turnover24h', d.q],
        ]),
      };
    default:
      return null;
  }
}

/** Highest initial leverage per symbol from `GET /fapi/v1/leverageBracket`. */
export function maxLeverageBySymbol(
  rows: { symbol: string; brackets?: { initialLeverage?: number }[] }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const max = Math.max(...(r.brackets ?? []).map((b) => num(b.initialLeverage) ?? 0));
    if (max > 0) map.set(r.symbol, max);
  }
  return map;
}

/** HMAC-SHA256 signature for Binance SIGNED / USER_DATA endpoints. */
export function signQuery(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

/**
 * `{symbol}@aggTrade`: trades at the same price and taker side within 100 ms are aggregated
 * (Binance docs), so one event can be several fills. `m` = buyer was the maker → taker sold.
 */
export function parseAggTrade(d: Record<string, unknown>): TradeEvent | null {
  if (d.e !== 'aggTrade' || typeof d.s !== 'string') return null;
  const price = num(d.p);
  const size = num(d.q);
  const ts = num(d.T);
  if (price === undefined || size === undefined || ts === undefined || typeof d.m !== 'boolean') return null;
  return { exchange: 'binance', symbol: d.s, ts, price, size, side: d.m ? 'sell' : 'buy' };
}
