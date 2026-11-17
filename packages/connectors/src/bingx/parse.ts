import { unavailable, type InstrumentInfo, type MarketField, type TradeEvent } from '@mip/core';
import { num, putNumbers, splitBase } from '../base/symbols.js';

/** BingX Swap V2 `/openApi/swap/v2/quote/contracts` row (fields we use). */
export interface BingxContract {
  symbol: string;
  asset: string;
  currency: string;
  status: number;
  pricePrecision?: number;
  launchTime?: number;
}

/**
 * Non-crypto contracts are listed as ordinary USDT perpetuals with an "NC" prefix family
 * (contract list surveyed 2026-11-17): NCFX forex (42), NCCO commodities (27), NCSK stocks (658),
 * NCSI indices (14). They are excluded by prefix.
 */
const NON_CRYPTO_PREFIX = /^NC(FX|CO|SK|SI)/;

export function isCryptoUsdtPerp(c: BingxContract): boolean {
  return (
    c.status === 1 && c.currency === 'USDT' && c.symbol.endsWith('-USDT') && !NON_CRYPTO_PREFIX.test(c.symbol)
  );
}

export function toInstrument(c: BingxContract): InstrumentInfo {
  const base = c.symbol.slice(0, -'-USDT'.length);
  const { asset, multiplier } = splitBase(base);
  return {
    exchange: 'bingx',
    symbol: c.symbol,
    base,
    asset,
    multiplier,
    quote: c.currency,
    contractSize: 1,
    tickSize: c.pricePrecision === undefined ? null : 10 ** -c.pricePrecision,
    maxLeverage: unavailable('not_provided', 'not in the public contract data'),
    indexKind: 'index',
    launchTime: c.launchTime || null,
    url: `https://bingx.com/en/perpetual/${c.symbol}`,
  };
}

/** REST `premiumIndex` row: mark, index, live funding rate, interval and next settlement. */
export function parsePremiumIndex(r: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['mark', r.markPrice],
    ['index', r.indexPrice],
    ['fundingRate', r.lastFundingRate],
    ['fundingIntervalHours', r.fundingIntervalHours],
    ['nextFundingTime', r.nextFundingTime],
  ]);
}

/** REST `ticker` row. */
export function parseTicker(r: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['last', r.lastPrice],
    ['bid', r.bidPrice],
    ['bidSize', r.bidQty],
    ['ask', r.askPrice],
    ['askSize', r.askQty],
    ['turnover24h', r.quoteVolume],
  ]);
}

/** WS events (`data` of a push): bookTicker, markPriceUpdate, 24hTicker. */
export function parseStreamEvent(
  d: Record<string, unknown>,
): { symbol: string; ts: number | null; values: Partial<Record<MarketField, number>> } | null {
  const symbol = typeof d.s === 'string' ? d.s : null;
  if (!symbol) return null;
  const ts = num(d.E) ?? null;
  switch (d.e) {
    case 'bookTicker':
      return {
        symbol,
        ts,
        values: putNumbers<MarketField>({}, [
          ['bid', d.b],
          ['bidSize', d.B],
          ['ask', d.a],
          ['askSize', d.A],
        ]),
      };
    case 'markPriceUpdate':
      return { symbol, ts, values: putNumbers<MarketField>({}, [['mark', d.p]]) };
    case '24hTicker':
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

/**
 * Open interest arrives as a USDT notional value (unit inferred: BTC-USDT returned ~6.9e8,
 * impossible as coins and the docs do not state the unit). It is converted to base units with
 * the mark price, so the result carries the mark price's noise.
 */
export function openInterestToBase(notional: number, mark: number): number | undefined {
  return mark > 0 && Number.isFinite(notional) ? notional / mark : undefined;
}

/** `{symbol}@trade` items: p, q (base), T time, m = buyer was the maker → taker sold. */
export function parseTrades(items: unknown): TradeEvent[] {
  if (!Array.isArray(items)) return [];
  const out: TradeEvent[] = [];
  for (const t of items as Record<string, unknown>[]) {
    const price = num(t.p);
    const size = num(t.q);
    const ts = num(t.T);
    if (
      price === undefined ||
      size === undefined ||
      ts === undefined ||
      typeof t.m !== 'boolean' ||
      typeof t.s !== 'string'
    )
      continue;
    out.push({ exchange: 'bingx', symbol: t.s, ts, price, size, side: t.m ? 'sell' : 'buy' });
  }
  return out;
}
