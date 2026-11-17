import type { CommonSettings, ExchangeId, ScannerId } from '@mip/core';
import type { MarketView } from '../view.js';

/** A condition a scanner found in the current market view. */
export interface Candidate {
  /** Deduplication key within the scanner (e.g. "bybit:BTCUSDT:LONG"). */
  key: string;
  exchange: ExchangeId | null;
  symbol: string | null;
  asset: string;
  direction: string | null;
  /** Primary metric, e.g. deviation in percent. Signed. */
  value: number;
  /** One-line summary, e.g. "LONG BTCUSDT on Bybit: market −0.62 % below fair". */
  title: string;
  /** Scanner-specific details; JSON-serialisable. */
  data: Record<string, unknown>;
}

export interface EvaluationResult {
  candidates: Candidate[];
  /** How many instruments / assets were looked at. */
  evaluated: number;
  /** Shown in the scanner status (e.g. "OI history warming up"). */
  warnings: string[];
}

export interface ScannerDefinition<S extends CommonSettings = CommonSettings> {
  id: ScannerId;
  /** How often to evaluate. */
  intervalMs: number;
  evaluate(view: MarketView, settings: S, now: number): EvaluationResult | Promise<EvaluationResult>;
  /** Telegram message (HTML) for a signal; `status` tells whether it is open or resolved. */
  format(
    signal: { value: number; data: Record<string, unknown>; title: string },
    status: FormatStatus,
  ): string;
  /** Overrides the default "relative change of `value` ≥ significantChangePct". */
  significantChange?(previous: Candidate, next: Candidate, settings: S): boolean;
}

export interface FormatStatus {
  state: 'active' | 'resolved';
  firstSeenAt: number;
  updatedAt: number;
  updates: number;
}

/** Common filters every scanner applies to a row (exchange, asset include / exclude). */
export function passesCommonFilters(
  s: CommonSettings,
  exchange: ExchangeId | null,
  assetCode: string,
): boolean {
  if (exchange && s.exchanges.length > 0 && !s.exchanges.includes(exchange)) return false;
  const code = assetCode.toUpperCase();
  if (s.includeAssets.length > 0 && !s.includeAssets.some((a) => a.toUpperCase() === code)) return false;
  if (s.excludeAssets.some((a) => a.toUpperCase() === code)) return false;
  return true;
}
