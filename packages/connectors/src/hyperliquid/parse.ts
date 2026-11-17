import { available, type InstrumentInfo, type MarketField, type TradeEvent } from '@mip/core';
import { num, putNumbers, splitBase } from '../base/symbols.js';

export interface HlUniverseEntry {
  name: string;
  szDecimals?: number;
  maxLeverage?: number;
  isDelisted?: boolean;
}

/** Funding is paid every hour on Hyperliquid (docs: hourly payment of 1/8 of the 8 h rate). */
export const HL_FUNDING_INTERVAL_HOURS = 1;
const HOUR = 3_600_000;

/** The next full hour after `now`: Hyperliquid's documented funding schedule. */
export function nextHourlyFunding(now: number): number {
  return Math.floor(now / HOUR) * HOUR + HOUR;
}

export function toInstrument(u: HlUniverseEntry): InstrumentInfo {
  const { asset, multiplier } = splitBase(u.name);
  return {
    exchange: 'hyperliquid',
    symbol: u.name,
    base: u.name,
    asset,
    multiplier,
    // Perpetuals on the main dex are margined and settled in USDC.
    quote: 'USDC',
    contractSize: 1,
    tickSize: null, // price precision rule: 5 significant figures, at most 6 - szDecimals decimals
    maxLeverage: u.maxLeverage
      ? available(u.maxLeverage, Date.now())
      : { available: false, reason: 'not_received' },
    indexKind: 'oracle',
    launchTime: null,
    url: `https://app.hyperliquid.xyz/trade/${u.name}`,
  };
}

/**
 * Asset context (REST `metaAndAssetCtxs` element or WS `activeAssetCtx`). There is no index
 * price; the oracle price is the analogue. `funding` is the current hourly rate; `dayNtlVlm`
 * is 24 h notional volume in USDC. No last trade price here (it comes from the trades stream).
 */
export function parseAssetCtx(
  ctx: Record<string, unknown>,
  now: number,
): Partial<Record<MarketField, number>> {
  const out = putNumbers<MarketField>({}, [
    ['mark', ctx.markPx],
    ['index', ctx.oraclePx],
    ['fundingRate', ctx.funding],
    ['openInterest', ctx.openInterest],
    ['turnover24h', ctx.dayNtlVlm],
  ]);
  out.fundingIntervalHours = HL_FUNDING_INTERVAL_HOURS;
  out.nextFundingTime = nextHourlyFunding(now);
  return out;
}

/** WS `bbo`: [bid, ask], either side may be null when the book side is empty. */
export function parseBbo(d: Record<string, unknown>): {
  ts: number | null;
  values: Partial<Record<MarketField, number>>;
} {
  const [bid, ask] = (Array.isArray(d.bbo) ? d.bbo : []) as ({ px?: string; sz?: string } | null)[];
  return {
    ts: num(d.time) ?? null,
    values: putNumbers<MarketField>({}, [
      ['bid', bid?.px],
      ['bidSize', bid?.sz],
      ['ask', ask?.px],
      ['askSize', ask?.sz],
    ]),
  };
}

/** WS `trades`: the last trade of a batch gives the last price. */
export function lastTrade(trades: unknown): { coin: string; px: number; time: number } | null {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  let latest: { coin: string; px: number; time: number } | null = null;
  for (const t of trades as { coin?: string; px?: string; time?: number }[]) {
    const px = num(t.px);
    if (!t.coin || px === undefined || typeof t.time !== 'number') continue;
    if (!latest || t.time >= latest.time) latest = { coin: t.coin, px, time: t.time };
  }
  return latest;
}

/**
 * WS `trades` items with the aggressor side ("B" = taker bought, "A" = taker sold), both wallet
 * addresses ([buyer, seller]) and the transaction hash (all zeros for TWAP slices, per the docs).
 */
export function parseTrades(items: unknown): TradeEvent[] {
  if (!Array.isArray(items)) return [];
  const out: TradeEvent[] = [];
  for (const t of items as Record<string, unknown>[]) {
    const price = num(t.px);
    const size = num(t.sz);
    const ts = num(t.time);
    const side = t.side === 'B' ? 'buy' : t.side === 'A' ? 'sell' : null;
    if (typeof t.coin !== 'string' || price === undefined || size === undefined || ts === undefined || !side)
      continue;
    const users =
      Array.isArray(t.users) && t.users.length === 2
        ? ([String(t.users[0]), String(t.users[1])] as [string, string])
        : undefined;
    out.push({
      exchange: 'hyperliquid',
      symbol: t.coin,
      ts,
      price,
      size,
      side,
      ...(users ? { users } : {}),
      ...(typeof t.hash === 'string' ? { hash: t.hash } : {}),
    });
  }
  return out;
}

/** TWAP slice fills carry a zero transaction hash (Hyperliquid docs, userTwapSliceFills). */
export const isZeroHash = (hash: string | undefined): boolean => !!hash && /^0x0+$/.test(hash);
