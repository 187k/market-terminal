import { available, unavailable, type InstrumentInfo, type MarketField, type TradeEvent } from '@mip/core';
import { num, putNumbers, splitBase } from '../base/symbols.js';

/** Bitget V2 `/api/v2/mix/market/contracts` row (fields we use). */
export interface BitgetContract {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  symbolType: string;
  symbolStatus: string;
  isRwa?: string;
  pricePlace?: string;
  priceEndStep?: string;
  maxLever?: string;
  launchTime?: string;
  fundInterval?: string;
}

/** Tradable crypto USDT perpetuals; `isRwa = YES` marks stock / commodity contracts. */
export function isCryptoUsdtPerp(c: BitgetContract): boolean {
  return (
    c.symbolType === 'perpetual' && c.symbolStatus === 'normal' && c.quoteCoin === 'USDT' && c.isRwa !== 'YES'
  );
}

export function toInstrument(c: BitgetContract): InstrumentInfo {
  const { asset, multiplier } = splitBase(c.baseCoin);
  const places = num(c.pricePlace);
  const step = num(c.priceEndStep) ?? 1;
  const lev = num(c.maxLever);
  const launch = num(c.launchTime);
  return {
    exchange: 'bitget',
    symbol: c.symbol,
    base: c.baseCoin,
    asset,
    multiplier,
    quote: c.quoteCoin,
    contractSize: 1,
    tickSize: places === undefined ? null : step / 10 ** places,
    maxLeverage: lev === undefined ? unavailable('not_received') : available(lev, Date.now()),
    indexKind: 'index',
    launchTime: launch ?? null,
    url: `https://www.bitget.com/futures/usdt/${c.symbol}`,
  };
}

/**
 * Ticker: REST `/market/tickers` row or WS `ticker` channel item (same field names).
 * `holdingAmount` is open interest in base coin.
 */
export function parseTicker(t: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['last', t.lastPr],
    ['mark', t.markPrice],
    ['index', t.indexPrice],
    ['bid', t.bidPr],
    ['ask', t.askPr],
    ['bidSize', t.bidSz],
    ['askSize', t.askSz],
    ['openInterest', t.holdingAmount],
    ['fundingRate', t.fundingRate],
    ['nextFundingTime', t.nextFundingTime],
    ['turnover24h', t.quoteVolume],
  ]);
}

/** `/market/current-fund-rate` row: funding interval (hours) and next settlement. */
export function parseFundRate(r: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['fundingRate', r.fundingRate],
    ['fundingIntervalHours', r.fundingRateInterval],
    ['nextFundingTime', r.nextUpdate],
  ]);
}

/** `trade` channel items: ts, price, size (base coin), side = taker side. */
export function parseTrades(symbol: string, items: unknown): TradeEvent[] {
  if (!Array.isArray(items)) return [];
  const out: TradeEvent[] = [];
  for (const t of items as Record<string, unknown>[]) {
    const price = num(t.price);
    const size = num(t.size);
    const ts = num(t.ts);
    const side = t.side === 'buy' ? 'buy' : t.side === 'sell' ? 'sell' : null;
    if (price === undefined || size === undefined || ts === undefined || !side) continue;
    out.push({ exchange: 'bitget', symbol, ts, price, size, side });
  }
  return out;
}
