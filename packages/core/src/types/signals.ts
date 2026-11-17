import type { ExchangeId } from './exchanges.js';
import type { ScannerId } from './scanners.js';

export type SignalStatus = 'active' | 'resolved';

/** What happened with the Telegram message of a signal. */
export type TelegramState =
  /** Delivered (and edited on updates). */
  | 'sent'
  /** Waiting in the outbound queue. */
  | 'queued'
  /** No bot token / chat configured, or notifications switched off for the scanner. */
  | 'disabled'
  /** Delivery failed; see detail. */
  | 'failed';

/** One detected market situation, from first detection until it resolves. */
export interface SignalDto {
  id: string;
  scanner: ScannerId;
  /** Deduplication key: one open signal per key (e.g. "bybit:BTCUSDT:LONG"). */
  key: string;
  /** Null for cross-exchange signals (funding arbitrage, spreads). */
  exchange: ExchangeId | null;
  symbol: string | null;
  asset: string;
  direction: string | null;
  title: string;
  /** The scanner's primary metric (e.g. deviation %), used for sorting and change detection. */
  value: number;
  /** Largest absolute value seen while active. */
  peakValue: number;
  status: SignalStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  /** How many times the signal changed significantly after it opened. */
  updates: number;
  /** Scanner-specific details (rendered by the dashboard and the Telegram formatter). */
  data: Record<string, unknown>;
  telegram: { state: TelegramState; messageId: number | null; detail: string | null };
}

export interface ScannerStatusDto {
  id: ScannerId;
  enabled: boolean;
  /** Last evaluation time and duration; null before the first run. */
  lastRunAt: number | null;
  lastRunMs: number | null;
  /** Instruments / assets evaluated and candidates found in the last run. */
  evaluated: number;
  candidates: number;
  active: number;
  signals24h: number;
  lastSignalAt: number | null;
  telegram: { state: 'ok' | 'disabled' | 'error'; detail: string | null };
  /** Data or configuration problems worth showing (e.g. "OI history warming up: 12 min of 4 h"). */
  warnings: string[];
  error: string | null;
}

export interface SignalsResponse {
  signals: SignalDto[];
}

export interface ScannersResponse {
  scanners: ScannerStatusDto[];
  /** When the engine last published; null if it never did. */
  updatedAt: number | null;
}

/** Stored settings of one scanner: common fields plus scanner-specific thresholds. */
export interface ScannerSettingsDto {
  scanner: ScannerId;
  enabled: boolean;
  settings: Record<string, unknown>;
  /** The defaults, so a client can show and reset them. */
  defaults: Record<string, unknown>;
  /** JSON Schema of the settings (types, bounds, allowed values) for building a form. */
  schema: Record<string, unknown>;
  updatedAt: number | null;
}

/** Exchange ids allowed in settings filters. */
export type ExchangeFilter = ExchangeId[];
