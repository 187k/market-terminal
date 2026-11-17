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
