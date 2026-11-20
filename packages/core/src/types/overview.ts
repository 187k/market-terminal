import type { ExchangeId } from './exchanges.js';

/**
 * Home page data. Spot figures come from CoinGecko (polled by the collector); perpetual
 * figures are computed from the collector's live snapshots of the monitored exchanges.
 */

/** CoinGecko spot figures for one coin, in USD. Null means CoinGecko did not report the value. */
export interface CoinSpotStats {
  /** CoinGecko id, e.g. "bitcoin". */
  id: string;
  /** CoinGecko ticker, upper case. Not unique across coins; join by `id`. */
  symbol: string;
  name: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  marketCapRank: number | null;
  volume24hUsd: number | null;
  high24hUsd: number | null;
  low24hUsd: number | null;
  change1hPct: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  athUsd: number | null;
  /** Distance from the all-time high in percent (negative below it). */
  athChangePct: number | null;
  athAt: number | null;
  /** When CoinGecko last updated this coin (Unix ms). */
  updatedAt: number | null;
  /**
   * Prices over the last 7 days, oldest first, roughly one per hour (CoinGecko
   * `sparkline_in_7d`; it gives no timestamps). Empty when not reported.
   */
  sparkline7d: number[];
}

/** Whole-market figures from CoinGecko `/global`. */
export interface GlobalMarketStats {
  totalMarketCapUsd: number | null;
  totalVolume24hUsd: number | null;
  marketCapChange24hPct: number | null;
  btcDominancePct: number | null;
  ethDominancePct: number | null;
  activeCryptocurrencies: number | null;
  /** Exchanges CoinGecko tracks. */
  markets: number | null;
  /**
   * CoinGecko's Fear & Greed reading (0–100) and its label. Observed in `/global` but not part
   * of the documented schema [O], so it may disappear; null when absent.
   */
  fearGreed: { value: number; label: string } | null;
  /** When CoinGecko computed these figures (Unix ms). */
  updatedAt: number | null;
}

/** One universe asset with its CoinGecko figures. */
export interface OverviewCoin {
  /** Asset code used by signals and the coin view, e.g. "PEPE". */
  asset: string;
  name: string;
  /** Rank within the monitored universe (1 = largest). */
  rank: number;
  /** Null when CoinGecko returned nothing for the asset. */
  spot: CoinSpotStats | null;
}

/** `GET /api/overview` and realtime topic `overview`. */
export interface MarketOverviewResponse {
  source: 'coingecko';
  /** Universe assets in rank order. */
  coins: OverviewCoin[];
  /** When the collector last fetched the coin figures successfully; null if never. */
  coinsFetchedAt: number | null;
  coinsStale: boolean;
  global: GlobalMarketStats | null;
  globalFetchedAt: number | null;
  globalStale: boolean;
  /** CoinGecko figures older than this are labelled stale. */
  staleAfterMs: number;
  /** Plain-language problems to show: failed fetches, missing universe, volume ranking. */
  notes: string[];
}

/** The lowest or highest 24 h funding among an asset's exchanges. */
export interface FundingExtreme {
  exchange: ExchangeId;
  /** Percent per 24 h (rate × 24 / interval × 100). */
  rate24hPct: number;
}

/**
 * Live perpetual figures for one asset across the monitored exchanges. Only fresh values are
 * used; a figure with no fresh input is null and `venues` says how many exchanges contributed.
 */
export interface PerpSummary {
  asset: string;
  /** Exchanges with at least one fresh value for this asset. */
  venues: ExchangeId[];
  /** Median over exchanges of (mark − index) / index × 100; Hyperliquid uses its oracle price. */
  premiumPct: number | null;
  /** Median over exchanges of the funding rate normalised to 24 h, in percent. */
  funding24hPct: number | null;
  fundingLow: FundingExtreme | null;
  fundingHigh: FundingExtreme | null;
  /** Sum over exchanges of open interest (one side) × mark, quote currency (USDT, USDC on Hyperliquid). */
  openInterestUsd: number | null;
  /** Exchanges included in `openInterestUsd`. */
  oiVenues: ExchangeId[];
  /**
   * Change of open interest in asset units against the minute snapshot nearest 24 h ago,
   * summed over the exchanges that have both values. Null while that history is missing.
   */
  oiChange24hPct: number | null;
  /** Sum of 24 h perpetual turnover over exchanges, quote currency. */
  turnover24hUsd: number | null;
}

/** `GET /api/overview/perps` and realtime topic `perps`. */
export interface PerpOverviewResponse {
  assets: PerpSummary[];
  totals: {
    openInterestUsd: number | null;
    turnover24hUsd: number | null;
    /** Median of the assets' median 24 h funding, in percent. */
    funding24hPct: number | null;
  };
  /** Exchanges whose collector snapshot is too old; their values are left out. */
  staleExchanges: ExchangeId[];
  /** When the 24 h-ago snapshots were read; null when the database had none near that time. */
  oiBaselineAt: number | null;
}
