import type { CoinSpotStats, GlobalMarketStats } from '@mip/core';

/**
 * Pure normalisation of CoinGecko REST payloads. A value CoinGecko leaves out, sends as null or
 * sends as something other than a finite number becomes null; nothing is filled in.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Prices, caps and supplies: CoinGecko reports 0 for "unknown" on some coins, so only > 0 counts. */
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

const time = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** One `/coins/markets` row (requested with `sparkline=true&price_change_percentage=1h,24h,7d`). */
export function parseCoinSpot(raw: unknown): CoinSpotStats | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id === '') return null;
  const spark = isObj(raw.sparkline_in_7d) ? raw.sparkline_in_7d.price : undefined;
  return {
    id: raw.id,
    symbol: typeof raw.symbol === 'string' ? raw.symbol.toUpperCase() : '',
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    priceUsd: positive(raw.current_price),
    marketCapUsd: positive(raw.market_cap),
    marketCapRank: positive(raw.market_cap_rank),
    volume24hUsd: num(raw.total_volume),
    high24hUsd: positive(raw.high_24h),
    low24hUsd: positive(raw.low_24h),
    change1hPct: num(raw.price_change_percentage_1h_in_currency),
    // The `_in_currency` variant is what `price_change_percentage=24h` adds; the plain field is
    // always present and is the same figure in USD.
    change24hPct: num(raw.price_change_percentage_24h_in_currency) ?? num(raw.price_change_percentage_24h),
    change7dPct: num(raw.price_change_percentage_7d_in_currency),
    circulatingSupply: positive(raw.circulating_supply),
    totalSupply: positive(raw.total_supply),
    maxSupply: positive(raw.max_supply),
    athUsd: positive(raw.ath),
    athChangePct: num(raw.ath_change_percentage),
    athAt: time(raw.ath_date),
    updatedAt: time(raw.last_updated),
    // A gap in the series would shift every later point in time, so a series with any invalid
    // point is dropped rather than shown with a hole closed up.
    sparkline7d:
      Array.isArray(spark) && spark.every((p) => num(p) !== null && (p as number) > 0)
        ? (spark as number[])
        : [],
  };
}

export function parseCoinMarkets(raw: unknown): CoinSpotStats[] {
  if (!Array.isArray(raw)) throw new Error('unexpected /coins/markets response');
  return raw.map(parseCoinSpot).filter((c): c is CoinSpotStats => c !== null);
}

/** `/global`. */
export function parseGlobal(raw: unknown): GlobalMarketStats {
  const d = isObj(raw) && isObj(raw.data) ? raw.data : null;
  if (!d) throw new Error('unexpected /global response');
  const usd = (field: unknown) => (isObj(field) ? positive(field.usd) : null);
  const share = isObj(d.market_cap_percentage) ? d.market_cap_percentage : {};
  const fg = isObj(d.fear_and_greed_index) ? d.fear_and_greed_index : null;
  const fgValue = fg ? num(fg.value) : null;
  const updated = num(d.updated_at);
  return {
    totalMarketCapUsd: usd(d.total_market_cap),
    totalVolume24hUsd: usd(d.total_volume),
    marketCapChange24hPct: num(d.market_cap_change_percentage_24h_usd),
    btcDominancePct: num(share.btc),
    ethDominancePct: num(share.eth),
    activeCryptocurrencies: positive(d.active_cryptocurrencies),
    markets: positive(d.markets),
    fearGreed:
      fg && fgValue !== null && fgValue >= 0 && fgValue <= 100
        ? { value: fgValue, label: typeof fg.sentiment === 'string' ? fg.sentiment.replace(/_/g, ' ') : '' }
        : null,
    // Unix seconds.
    updatedAt: updated !== null && updated > 0 ? updated * 1000 : null,
  };
}
