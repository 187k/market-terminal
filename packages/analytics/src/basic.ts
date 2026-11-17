/** Relative difference in percent: (value - reference) / reference × 100. Null if undefined. */
export function pctDiff(value: number, reference: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference === 0) return null;
  return ((value - reference) / reference) * 100;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Sample standard deviation (n − 1). Null for fewer than two values. */
export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/** Coefficient of variation (stdev / mean). Small values mean very regular series. */
export function coefficientOfVariation(values: readonly number[]): number | null {
  const m = mean(values);
  const sd = stdev(values);
  if (m === null || sd === null || m === 0) return null;
  return sd / Math.abs(m);
}
