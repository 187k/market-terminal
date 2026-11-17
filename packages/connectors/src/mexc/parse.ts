import { available, unavailable, type InstrumentInfo, type MarketField, type TradeEvent } from '@mip/core';
import { num, putNumbers, splitBase } from '../base/symbols.js';

/** MEXC futures `/api/v1/contract/detail` row (fields we use). */
export interface MexcContract {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  /** 1 = perpetual. */
  futureType: number;
  contractSize: number;
  priceUnit?: number;
  maxLeverage?: number;
  /** 0 = enabled. */
  state: number;
  isHidden?: boolean;
  openingTime?: number;
}

export function isCryptoUsdtPerp(c: MexcContract): boolean {
  return (
    c.futureType === 1 &&
    c.state === 0 &&
    c.isHidden !== true &&
    c.quoteCoin === 'USDT' &&
    c.settleCoin === 'USDT' &&
    c.contractSize > 0
  );
}

export function toInstrument(c: MexcContract): InstrumentInfo {
  const { asset, multiplier } = splitBase(c.baseCoin);
  return {
    exchange: 'mexc',
    symbol: c.symbol,
    base: c.baseCoin,
    asset,
    multiplier,
    quote: c.quoteCoin,
    contractSize: c.contractSize,
    tickSize: c.priceUnit ?? null,
    maxLeverage: c.maxLeverage ? available(c.maxLeverage, Date.now()) : unavailable('not_received'),
    indexKind: 'index',
    launchTime: c.openingTime || null,
    url: `https://www.mexc.com/futures/${c.symbol}`,
  };
}

/**
 * Ticker: REST `/contract/ticker` row or WS `push.ticker` data (same field names).
 * `fairPrice` is MEXC's mark price; `holdVol` is open interest in contracts; `amount24` is
 * 24 h turnover in USDT. The ticker has best bid / ask prices but no sizes.
 */
export function parseTicker(
  t: Record<string, unknown>,
  contractSize: number,
): Partial<Record<MarketField, number>> {
  const out = putNumbers<MarketField>({}, [
    ['last', t.lastPrice],
    ['mark', t.fairPrice],
    ['index', t.indexPrice],
    ['bid', t.bid1],
    ['ask', t.ask1],
    ['fundingRate', t.fundingRate],
    ['turnover24h', t.amount24],
  ]);
  const hold = num(t.holdVol);
  if (hold !== undefined) out.openInterest = hold * contractSize;
  return out;
}

/** `/contract/funding_rate` row: `collectCycle` is the interval in hours. */
export function parseFundingRate(r: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['fundingRate', r.fundingRate],
    ['fundingIntervalHours', r.collectCycle],
    ['nextFundingTime', r.nextSettleTime],
  ]);
}

/** `push.deal` items: p price, v size in contracts, T 1 = buy / 2 = sell (taker), t time. */
export function parseDeals(symbol: string, items: unknown, contractSize: number): TradeEvent[] {
  if (!Array.isArray(items)) return [];
  const out: TradeEvent[] = [];
  for (const d of items as Record<string, unknown>[]) {
    const price = num(d.p);
    const vol = num(d.v);
    const ts = num(d.t);
    const side = d.T === 1 ? 'buy' : d.T === 2 ? 'sell' : null;
    if (price === undefined || vol === undefined || ts === undefined || !side) continue;
    out.push({ exchange: 'mexc', symbol, ts, price, size: vol * contractSize, side });
  }
  return out;
}
