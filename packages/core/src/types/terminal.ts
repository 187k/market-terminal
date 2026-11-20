import type { Field } from './availability.js';
import type { ExchangeId } from './exchanges.js';
import type { InstrumentInfo, MarketField } from './market.js';

/**
 * Types for the dashboard's view-only terminal (chart, order book, trades of one instrument).
 * Nothing here places orders: the terminal only displays public market data.
 */

/** Candle intervals every supported exchange offers through its public kline endpoint. */
export const CANDLE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;

export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const CANDLE_INTERVAL_MS: Readonly<Record<CandleInterval, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

export function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value);
}

/** One OHLCV candle as the exchange reports it. Prices per base unit, volume in base units. */
export interface Candle {
  /** Start of the candle period, Unix ms. */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded size in base units (contracts multiplied out). */
  volume: number;
  /** Traded value in quote currency; null where the exchange does not report it. */
  turnover: number | null;
}

/** Older candles for the chart (`GET /api/terminal/:exchange/:symbol/candles`). */
export interface CandlesResponse {
  exchange: ExchangeId;
  symbol: string;
  interval: CandleInterval;
  /** Oldest first. Empty when the exchange has no more history. */
  candles: Candle[];
  fetchedAt: number;
}

/** [price, size in base units], best level first. */
export type TerminalBookLevel = [number, number];

export interface TerminalBook {
  bids: TerminalBookLevel[];
  asks: TerminalBookLevel[];
  /** Exchange time of the book if given, else receive time. */
  ts: number;
  /** (best ask − best bid) / best bid × 100; null if a side is empty. */
  spreadPct: number | null;
}

/** One public trade from the collector's trade stream. */
export interface TerminalTrade {
  ts: number;
  price: number;
  /** Base units. */
  size: number;
  /** Taker side. */
  side: 'buy' | 'sell';
  /** Hyperliquid TWAP slice (exchange-confirmed by the zero transaction hash). */
  twapSlice?: true;
}

/** Summary of the last 24 hourly candles. */
export interface TerminalStats24h {
  open: number;
  high: number;
  low: number;
  /** Base units. */
  volume: number;
  /** Quote currency; null if the exchange's candles have no turnover. */
  turnover: number | null;
  /** Live last price (or the last candle's close) against `open`, percent. */
  changePct: number | null;
  /** Number of hourly candles the figures cover (24 when the instrument traded all day). */
  hours: number;
}

/**
 * Live view of one instrument (`GET /api/terminal/:exchange/:symbol?interval=`, realtime
 * topic `terminal:<exchange>:<symbol>:<interval>`). Each part fails on its own: an error in
 * one (for example an exchange ban stopping order-book requests) leaves the others intact.
 */
export interface TerminalLiveResponse {
  exchange: ExchangeId;
  symbol: string;
  interval: CandleInterval;
  /** Null when the instrument is not tracked (not in the monitored universe). */
  instrument: InstrumentInfo | null;
  /** Live values from the collector, with freshness. Null when not tracked. */
  fields: Record<MarketField, Field<number>> | null;
  /** The collector's snapshot is older than the reader limit; every field is then stale. */
  stale: boolean;
  /**
   * The newest candles of `interval` (the forming one last). Synced from the exchange's REST
   * endpoint every few seconds; between syncs the forming candle's close, high and low follow
   * the live last price. Its volume is the exchange's figure as of the last sync.
   */
  candles: Candle[];
  candlesSyncedAt: number | null;
  candlesError: string | null;
  stats24h: TerminalStats24h | null;
  statsError: string | null;
  book: TerminalBook | null;
  bookError: string | null;
  /** Newest first. Only trades the collector forwards (see `tradesMinNotional`). */
  trades: TerminalTrade[];
  /** Trades below this value (price × size, quote currency) are not in the stream. */
  tradesMinNotional: number;
  /** Since when the API has been reading the trade stream; null before it started. */
  tradesSince: number | null;
  /** Caveats about this exchange's data shown under the chart (units, sources). */
  notes: string[];
  ts: number;
}
