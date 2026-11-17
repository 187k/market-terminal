import type { ExchangeId, ScannerId, SignalDto } from '@mip/core/types';
import { exchangesOf, SIZE_METRIC, turnoverOf } from './signalView';

/**
 * What a dashboard window shows. These filters only change the view; what the scanner detects
 * and sends to Telegram is set in its settings.
 */
export interface WindowFilters {
  /** Empty = all exchanges. */
  exchanges: ExchangeId[];
  /** Part of the asset code or symbol, e.g. "BTC". */
  pair: string;
  /** Minimum 24 h turnover, USD; null = no minimum. */
  minTurnover: number | null;
  /** Minimum of the scanner's size figure (top of book, OI, executed volume); null = no minimum. */
  minSize: number | null;
}

export const NO_FILTERS: WindowFilters = { exchanges: [], pair: '', minTurnover: null, minSize: null };

export const filtersActive = (f: WindowFilters): boolean =>
  f.exchanges.length > 0 || f.pair.trim() !== '' || f.minTurnover !== null || f.minSize !== null;

/**
 * Applies the window filters. A signal whose turnover or size is unknown is hidden while a
 * minimum is set (it cannot be shown to pass), and counted so the window can say so.
 */
export function applyFilters(
  signals: SignalDto[],
  f: WindowFilters,
  scanner: ScannerId,
): { shown: SignalDto[]; unknown: number } {
  const pair = f.pair.trim().toUpperCase();
  const size = SIZE_METRIC[scanner];
  let unknown = 0;
  const shown = signals.filter((s) => {
    if (f.exchanges.length && !exchangesOf(s).some((e) => f.exchanges.includes(e))) return false;
    if (pair && !s.asset.toUpperCase().includes(pair) && !(s.symbol ?? '').toUpperCase().includes(pair))
      return false;
    if (f.minTurnover !== null) {
      const t = turnoverOf(s);
      if (t === null) {
        unknown++;
        return false;
      }
      if (t < f.minTurnover) return false;
    }
    if (f.minSize !== null && size) {
      const v = size.value(s);
      if (v === null) {
        unknown++;
        return false;
      }
      if (v < f.minSize) return false;
    }
    return true;
  });
  return { shown, unknown };
}
