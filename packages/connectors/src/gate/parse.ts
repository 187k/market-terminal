import { available, unavailable, type InstrumentInfo, type MarketField, type TradeEvent } from '@mip/core';
import { num, putNumbers, splitBase } from '../base/symbols.js';

/** Gate API v4 `/futures/usdt/contracts` row (fields we use). */
export interface GateContract {
  name: string;
  type?: string;
  status?: string;
  in_delisting?: boolean;
  is_pre_market?: boolean;
  contract_type?: string;
  quanto_multiplier: string;
  order_price_round?: string;
  leverage_max?: string;
  launch_time?: number;
  create_time?: number;
  funding_interval?: number;
  funding_next_apply?: number;
  enable_decimal?: boolean;
}

/**
 * Tradable crypto USDT perpetuals. `contract_type` is empty for crypto contracts; any other
 * value (e.g. stocks / indices) is excluded until reviewed.
 */
export function isCryptoUsdtPerp(c: GateContract): boolean {
  return (
    c.name.endsWith('_USDT') &&
    c.status === 'trading' &&
    c.in_delisting !== true &&
    c.is_pre_market !== true &&
    (c.type ?? 'direct') === 'direct' &&
    (c.contract_type ?? '') === ''
  );
}

export function toInstrument(c: GateContract): InstrumentInfo {
  const base = c.name.slice(0, -'_USDT'.length);
  const { asset, multiplier } = splitBase(base);
  const lev = num(c.leverage_max);
  const launch = c.launch_time ?? c.create_time;
  return {
    exchange: 'gate',
    symbol: c.name,
    base,
    asset,
    multiplier,
    quote: 'USDT',
    contractSize: num(c.quanto_multiplier) ?? 1,
    tickSize: num(c.order_price_round) ?? null,
    maxLeverage: lev === undefined ? unavailable('not_received') : available(lev, Date.now()),
    indexKind: 'index',
    launchTime: launch ? launch * 1000 : null,
    url: `https://www.gate.com/futures/USDT/${c.name}`,
  };
}

/** Funding interval and next settlement from a contract row (seconds on the wire). */
export function parseContractFunding(c: GateContract): Partial<Record<MarketField, number>> {
  const out: Partial<Record<MarketField, number>> = {};
  if (c.funding_interval) out.fundingIntervalHours = c.funding_interval / 3600;
  if (c.funding_next_apply) out.nextFundingTime = c.funding_next_apply * 1000;
  return out;
}

/**
 * Ticker (REST row or WS `futures.tickers` item). Sizes are in contracts and are multiplied by
 * `quanto_multiplier`. Open interest: `total_size` counts both sides; it equals exactly twice
 * the contract's `position_size` ("current total long position size" in the Gate docs) on
 * every contract checked, so one side is total_size / 2.
 */
export function parseTicker(
  t: Record<string, unknown>,
  contractSize: number,
): Partial<Record<MarketField, number>> {
  const out = putNumbers<MarketField>({}, [
    ['last', t.last],
    ['mark', t.mark_price],
    ['index', t.index_price],
    ['bid', t.highest_bid],
    ['ask', t.lowest_ask],
    ['fundingRate', t.funding_rate],
    ['turnover24h', t.volume_24h_quote],
  ]);
  const bidSize = num(t.highest_size);
  const askSize = num(t.lowest_size);
  const totalSize = num(t.total_size);
  if (bidSize !== undefined) out.bidSize = bidSize * contractSize;
  if (askSize !== undefined) out.askSize = askSize * contractSize;
  if (totalSize !== undefined) out.openInterest = (totalSize / 2) * contractSize;
  const interval = num(t.funding_interval);
  const next = num(t.funding_next_apply);
  if (interval) out.fundingIntervalHours = interval / 3600;
  if (next) out.nextFundingTime = next * 1000;
  return out;
}

/** WS `futures.book_ticker` result: b/a prices, B/A sizes in contracts. */
export function parseBookTicker(
  r: Record<string, unknown>,
  contractSize: number,
): Partial<Record<MarketField, number>> {
  const out = putNumbers<MarketField>({}, [
    ['bid', r.b],
    ['ask', r.a],
  ]);
  const b = num(r.B);
  const a = num(r.A);
  if (b !== undefined) out.bidSize = b * contractSize;
  if (a !== undefined) out.askSize = a * contractSize;
  return out;
}

/** `futures.trades` items: size in contracts, positive = taker bought, negative = taker sold. */
export function parseTrades(
  items: unknown,
  contractSizeOf: (symbol: string) => number | undefined,
): TradeEvent[] {
  if (!Array.isArray(items)) return [];
  const out: TradeEvent[] = [];
  for (const t of items as Record<string, unknown>[]) {
    const symbol = typeof t.contract === 'string' ? t.contract : null;
    const cs = symbol ? contractSizeOf(symbol) : undefined;
    const price = num(t.price);
    const size = num(t.size);
    const ts = num(t.create_time_ms);
    if (
      !symbol ||
      cs === undefined ||
      price === undefined ||
      size === undefined ||
      size === 0 ||
      ts === undefined
    )
      continue;
    out.push({
      exchange: 'gate',
      symbol,
      ts,
      price,
      size: Math.abs(size) * cs,
      side: size > 0 ? 'buy' : 'sell',
    });
  }
  return out;
}
