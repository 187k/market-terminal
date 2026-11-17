import { EXCHANGE_NAMES, type ExchangeId } from '@mip/core';
import type { FormatStatus } from './scanners/types.js';

/** Escapes text for Telegram's HTML parse mode. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function link(text: string, url: string | null | undefined): string {
  return url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text);
}

export const exchangeName = (e: ExchangeId | string | null | undefined): string =>
  e ? (EXCHANGE_NAMES[e as ExchangeId] ?? e) : '—';

/** Prices with enough significant digits for small-unit coins. */
export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return Number(v.toPrecision(5)).toString();
}

/** Signed percent: +0.53 %, −1.20 %. */
export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s} %`;
}

/** Funding fraction as percent with 4 decimals: 0.0001 → +0.0100 %. */
export function rate(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : pct(v * 100, 4);
}

/** Compact USD: $1.23M. */
export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `$${Math.abs(v).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })}`;
}

export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
}

/** "3h 05m", "12m". */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export const utcTime = (ts: number): string => new Date(ts).toISOString().slice(11, 19) + ' UTC';

/** Footer shared by every message: status line and the analytical-tool disclaimer. */
export function footer(status: FormatStatus): string {
  const head =
    status.state === 'resolved'
      ? `✅ <b>Resolved</b> ${utcTime(status.updatedAt)} (open ${duration(status.updatedAt - status.firstSeenAt)})`
      : status.updates > 0
        ? `🔄 Updated ${utcTime(status.updatedAt)} · first seen ${utcTime(status.firstSeenAt)}`
        : `🕒 ${utcTime(status.firstSeenAt)}`;
  return `${head}\n<i>Analytical signal, not a trading recommendation.</i>`;
}
