/**
 * Funding normalised to 24 hours: rate × 24 / interval. The interval is per contract and
 * changes (exchanges shorten it during extremes), so it must come from live data, never be
 * assumed to be 8 h.
 */
export function funding24h(rate: number, intervalHours: number): number | null {
  if (!Number.isFinite(rate) || !(intervalHours > 0)) return null;
  return (rate * 24) / intervalHours;
}

export interface FundingLeg {
  key: string;
  rate24h: number;
}

/**
 * Funding arbitrage pair: long where 24 h funding is lowest (receive or pay least), short
 * where it is highest. `difference24h` is what the pair collects per 24 h before fees and
 * price moves, as a fraction of notional.
 */
export function bestFundingPair<T extends FundingLeg>(
  legs: readonly T[],
): { long: T; short: T; difference24h: number } | null {
  if (legs.length < 2) return null;
  let low = legs[0]!;
  let high = legs[0]!;
  for (const l of legs) {
    if (l.rate24h < low.rate24h) low = l;
    if (l.rate24h > high.rate24h) high = l;
  }
  if (low === high) return null;
  return { long: low, short: high, difference24h: high.rate24h - low.rate24h };
}
