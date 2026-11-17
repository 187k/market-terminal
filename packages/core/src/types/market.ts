import type { Field, UnavailableReason } from './availability.js';
import type { ExchangeId } from './exchanges.js';

/**
 * Live metrics every connector maps its exchange payloads onto. Units are fixed here so
 * nothing downstream has to know an exchange's conventions:
 *
 * - prices are in quote currency per **base unit** of the instrument (the unit the exchange
 *   names its base in, e.g. one "1000PEPE"); `InstrumentInfo.multiplier` converts to the asset;
 * - sizes and open interest are in base units (contracts are already multiplied out);
 * - open interest counts **one side** (long = short), the standard definition;
 * - funding rate is a fraction per funding interval (0.0001 = 0.01 %);
 * - times are Unix milliseconds.
 */
export const MARKET_FIELDS = [
  /** Last traded price. */
  'last',
  /** Mark / fair price used by the exchange for PnL and liquidations. */
  'mark',
  /** Index price. Hyperliquid has no index; its oracle price is used (InstrumentInfo.indexKind). */
  'index',
  'bid',
  'ask',
  /** Size at the best bid, base units. */
  'bidSize',
  /** Size at the best ask, base units. */
  'askSize',
  /** Open interest, one side, base units. */
  'openInterest',
  /** Current (upcoming-settlement) funding rate, fraction per interval. */
  'fundingRate',
  'fundingIntervalHours',
  'nextFundingTime',
  /** 24 h traded value in quote currency. */
  'turnover24h',
] as const;

export type MarketField = (typeof MARKET_FIELDS)[number];

export const MARKET_FIELD_LABELS: Record<MarketField, string> = {
  last: 'Last',
  mark: 'Mark',
  index: 'Index',
  bid: 'Bid',
  ask: 'Ask',
  bidSize: 'Bid size',
  askSize: 'Ask size',
  openInterest: 'Open interest',
  fundingRate: 'Funding',
  fundingIntervalHours: 'Funding interval',
  nextFundingTime: 'Next funding',
  turnover24h: '24 h turnover',
};

/** One normalised update from a connector: some fields of one instrument. */
export interface MarketUpdate {
  symbol: string;
  values: Partial<Record<MarketField, number>>;
  /** Exchange-side event time when the payload carries one, else null. */
  exchangeTs: number | null;
  /** Local receive time. */
  receivedAt: number;
  /** WebSocket connection that delivered it; null for REST. */
  connection: string | null;
}

/** One public trade, normalised: price per base unit, size in base units, taker side. */
export interface TradeEvent {
  exchange: ExchangeId;
  symbol: string;
  /** Exchange trade time. */
  ts: number;
  price: number;
  size: number;
  /** Side of the aggressor (taker). */
  side: 'buy' | 'sell';
  /** Hyperliquid only: [buyer, seller] wallet addresses. */
  users?: [string, string];
  /** Hyperliquid only: transaction hash; all zeros for TWAP slices (Hyperliquid docs). */
  hash?: string;
}

export type FieldSource = 'ws' | 'rest' | 'derived' | 'none';

/** How a connector obtains one field; drives freshness checks and "unavailable" reasons. */
export interface FieldCapability {
  source: FieldSource;
  /**
   * `change`: pushed whenever it changes, so a quiet value stays valid while the stream is up.
   * `interval`: refreshed on a schedule (polling, or a stream that pushes every N seconds).
   */
  refresh?: 'change' | 'interval';
  /** Older than this (since the last update, or since the last message for `change`) = stale. */
  maxAgeMs?: number;
  /** Why the field is unavailable when `source` is `none`. Defaults to `not_provided`. */
  reason?: UnavailableReason;
  /** Shown in the dashboard, e.g. "oracle price" or "derived from documented hourly schedule". */
  note?: string;
}

export type ExchangeCapabilities = Record<MarketField, FieldCapability>;

/** Static description of one tradable perpetual contract. */
export interface InstrumentInfo {
  exchange: ExchangeId;
  /** The exchange's own symbol, e.g. BTCUSDT, BTC_USDT, BTC-USDT, kPEPE. */
  symbol: string;
  /** Base as the exchange names it, e.g. "1000PEPE", "kPEPE". */
  base: string;
  /** Underlying asset code after removing a multiplier prefix, e.g. "PEPE". */
  asset: string;
  /** Asset units per base unit (1000 for 1000PEPE). */
  multiplier: number;
  /** Quote and settlement currency (USDT, or USDC on Hyperliquid). */
  quote: string;
  /** Base units per contract as the exchange counts sizes (1 when sizes are already in base units). */
  contractSize: number;
  tickSize: number | null;
  maxLeverage: Field<number>;
  /** "index" or, on Hyperliquid, "oracle". */
  indexKind: 'index' | 'oracle';
  launchTime: number | null;
  /** Exchange trading page. */
  url: string;
}

/** Instruments and a REST snapshot of current values, loaded before streams start. */
export interface MarketsBootstrap {
  /** Tradable crypto perpetuals (TradFi / RWA / non-USDT excluded by each connector). */
  instruments: InstrumentInfo[];
  updates: MarketUpdate[];
}

/** One instrument's evaluated live values, as published by the collector. */
export interface MarketRow {
  symbol: string;
  fields: Record<MarketField, Field<number>>;
}

/** Everything the collector publishes for one exchange, once per second. */
export interface ExchangeMarketSnapshot {
  exchange: ExchangeId;
  /** When the collector evaluated this snapshot. */
  ts: number;
  rows: MarketRow[];
}

/** Data-quality figures per exchange, shown next to connection health. */
export interface ExchangeDataHealth {
  /** Tradable crypto perpetuals listed by the exchange. */
  instruments: number;
  /** Instruments in the universe that are being streamed. */
  tracked: number;
  /** Tracked instruments whose mark, bid and ask are all currently fresh. */
  fresh: number;
  updatesPerSec: number;
  /** Values rejected by validation since start. */
  invalid: number;
  /** Typical delay between the exchange's event time and our receive time. */
  latencyMs: number | null;
  lastUpdateAt: number | null;
}

/** An asset selected for monitoring, and the instruments that represent it. */
export interface UniverseAsset {
  /** CoinGecko id (or the asset code when ranked by volume). */
  id: string;
  /** Canonical asset code, e.g. "PEPE". */
  symbol: string;
  name: string;
  /** 1..N within the universe. */
  rank: number;
  marketCapRank: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  instruments: { exchange: ExchangeId; symbol: string }[];
}

/** An exchange instrument that could not be tied to a universe asset safely. */
export interface MappingProblem {
  exchange: ExchangeId;
  symbol: string;
  assetId: string;
  reason: string;
}

export interface UniverseInfo {
  source: 'coingecko' | 'volume';
  builtAt: number;
  /** Requested size N. */
  size: number;
  assets: UniverseAsset[];
  problems: MappingProblem[];
  warnings: string[];
}
