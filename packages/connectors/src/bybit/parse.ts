import { available, type InstrumentInfo, type MarketField, type TradeEvent } from '@mip/core';
import { num, putNumbers, splitBase } from '../base/symbols.js';

/** Bybit V5 `instruments-info` row (linear). Only the fields we use. */
export interface BybitInstrument {
  symbol: string;
  contractType: string;
  status: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  launchTime?: string;
  symbolType?: string;
  fundingInterval?: number;
  priceFilter?: { tickSize?: string };
  leverageFilter?: { maxLeverage?: string };
}

/**
 * `symbolType` marks non-crypto contracts ("stock", "ETF", "commodity", "forex"). Only these
 * values are crypto; anything new is excluded until reviewed.
 */
const CRYPTO_SYMBOL_TYPES = new Set(['', 'innovation']);

export function isCryptoUsdtPerp(i: BybitInstrument): boolean {
  return (
    i.contractType === 'LinearPerpetual' &&
    i.status === 'Trading' &&
    i.quoteCoin === 'USDT' &&
    i.settleCoin === 'USDT' &&
    CRYPTO_SYMBOL_TYPES.has(i.symbolType ?? '')
  );
}

export function toInstrument(i: BybitInstrument): InstrumentInfo {
  const { asset, multiplier } = splitBase(i.baseCoin);
  const maxLeverage = num(i.leverageFilter?.maxLeverage);
  const launch = num(i.launchTime);
  return {
    exchange: 'bybit',
    symbol: i.symbol,
    base: i.baseCoin,
    asset,
    multiplier,
    quote: i.quoteCoin,
    contractSize: 1,
    tickSize: num(i.priceFilter?.tickSize) ?? null,
    maxLeverage:
      maxLeverage === undefined
        ? { available: false, reason: 'not_received' }
        : available(maxLeverage, Date.now()),
    indexKind: 'index',
    launchTime: launch ?? null,
    url: `https://www.bybit.com/trade/usdt/${i.symbol}`,
  };
}

/**
 * Maps a ticker (REST row, WS snapshot or WS delta) onto market fields. In a delta, a missing
 * field means "unchanged", so only present fields are returned.
 *
 * Open interest: `openInterest` counts both sides, `singleOpenInterest` one side (Bybit docs,
 * Get Tickers). We use the one-sided figure.
 */
export function parseTicker(t: Record<string, unknown>): Partial<Record<MarketField, number>> {
  return putNumbers<MarketField>({}, [
    ['last', t.lastPrice],
    ['mark', t.markPrice],
    ['index', t.indexPrice],
    ['bid', t.bid1Price],
    ['ask', t.ask1Price],
    ['bidSize', t.bid1Size],
    ['askSize', t.ask1Size],
    ['openInterest', t.singleOpenInterest],
    ['fundingRate', t.fundingRate],
    ['fundingIntervalHours', t.fundingIntervalHour],
    ['nextFundingTime', t.nextFundingTime],
    ['turnover24h', t.turnover24h],
  ]);
}

/** `publicTrade.{symbol}` items: T time, S taker side (Buy / Sell), v size (base), p price. */
export function parseTrades(items: unknown): TradeEvent[] {
  if (!Array.isArray(items)) return [];
  const out: TradeEvent[] = [];
  for (const t of items as Record<string, unknown>[]) {
    const price = num(t.p);
    const size = num(t.v);
    const ts = num(t.T);
    const side = t.S === 'Buy' ? 'buy' : t.S === 'Sell' ? 'sell' : null;
    if (price === undefined || size === undefined || ts === undefined || !side || typeof t.s !== 'string')
      continue;
    out.push({ exchange: 'bybit', symbol: t.s, ts, price, size, side });
  }
  return out;
}
