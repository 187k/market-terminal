/**
 * Splits an exchange base code into the underlying asset and its multiplier:
 * "1000PEPE" -> PEPE x1000, "1MBABYDOGE" -> BABYDOGE x1,000,000, "kPEPE" (Hyperliquid) -> PEPE x1000.
 * Codes that merely start with a digit ("1INCH", "0G", "2Z") are left alone: a prefix only counts
 * as a multiplier when it is 1000, 10000, 100000 or 1000000 followed by at least two more characters.
 */
export function splitBase(base: string): { asset: string; multiplier: number } {
  const numeric = /^(1000000|100000|10000|1000)([A-Z][A-Z0-9]+)$/.exec(base);
  if (numeric) return { asset: numeric[2]!, multiplier: Number(numeric[1]) };
  const million = /^1M([A-Z][A-Z0-9]+)$/.exec(base);
  if (million) return { asset: million[1]!, multiplier: 1_000_000 };
  const kilo = /^k([A-Z][A-Z0-9]+)$/.exec(base);
  if (kilo) return { asset: kilo[1]!, multiplier: 1000 };
  return { asset: base, multiplier: 1 };
}

/** Parses an exchange number (usually a string). Returns undefined for empty, null or non-finite input. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Copies parsed numbers into `target` under the given keys, skipping missing ones. */
export function putNumbers<K extends string>(
  target: Partial<Record<K, number>>,
  pairs: readonly (readonly [K, unknown])[],
): Partial<Record<K, number>> {
  for (const [key, raw] of pairs) {
    const n = num(raw);
    if (n !== undefined) target[key] = n;
  }
  return target;
}
