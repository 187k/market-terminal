export function formatClock(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Time of day for today, date and time otherwise. */
export function formatWhen(ts: number | null): string {
  if (ts === null) return '—';
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return formatClock(ts);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatAge(ts: number | null, now: number): string {
  if (ts === null) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function formatCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Prices keep enough significant digits for small-unit coins without padding large ones. */
export function formatPrice(v: number): string {
  if (v >= 1_000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return Number(v.toPrecision(5)).toString();
}

/** Large quantities (open interest, turnover) in compact form: 1.23M, 4.5B. */
export function formatCompact(v: number): string {
  return v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
}

/** Funding rate fraction as a percentage with 4 decimals (0.0001 -> 0.0100 %). */
export function formatRate(v: number): string {
  return `${(v * 100).toFixed(4)}%`;
}

/** Time until `ts`: "3h 05m", "12m 30s". */
export function formatCountdown(ts: number, now: number): string {
  const s = Math.round((ts - now) / 1000);
  if (s <= 0) return 'due';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Percentage with an explicit sign: +0.52 %, −1.30 %. */
export function formatSignedPct(v: number, digits = 2): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)} %`;
}

/** Length of a period: "45s", "12m 30s", "3h 05m", "2d 4h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Decimal places of a tick size (0.01 → 2, 0.5 → 1, 1e-7 → 7). */
export function tickDecimals(tick: number): number {
  for (let d = 0; d < 12; d++) {
    const x = tick * 10 ** d;
    if (Math.round(x) >= 1 && Math.abs(x - Math.round(x)) < 1e-6) return d;
  }
  return 12;
}

/**
 * Decimals to show prices with: the instrument's tick size when known, else five significant
 * figures of a reference price (Hyperliquid publishes no tick size; its prices have at most
 * five significant figures), else four.
 */
export function priceDecimals(tick: number | null, reference: number | null): number {
  if (tick !== null && tick > 0) return tickDecimals(tick);
  if (reference !== null && reference > 0)
    return Math.min(8, Math.max(0, 5 - (Math.floor(Math.log10(reference)) + 1)));
  return 4;
}

/** Order and trade sizes: three significant figures below 1, compact above 10,000. */
export function formatSize(v: number): string {
  if (v === 0) return '0';
  if (v < 1) return Number(v.toPrecision(3)).toString();
  if (v < 10_000) return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return formatCompact(v);
}

/** A percentage that may be tiny (an order-book spread): two significant figures. */
export function formatSmallPct(v: number): string {
  return `${Number(v.toPrecision(2))} %`;
}

/** Price with a fixed number of decimals (the instrument's tick precision), grouped thousands. */
export function formatFixed(v: number, decimals: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A USD price: "$58,324", "$0.3015". */
export function formatUsd(v: number): string {
  return `$${formatPrice(v)}`;
}

/** A large USD amount in compact form: "$1.17T", "$52.3B". */
export function formatUsdCompact(v: number): string {
  return `$${formatCompact(v)}`;
}
