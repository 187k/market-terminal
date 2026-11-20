import { median, pctDiff } from './basic.js';
import { funding24h } from './funding.js';

/** One exchange's perpetual for an asset. Null = the value is missing or not fresh. */
export interface PerpLeg {
  /** Label carried into the funding extremes (the exchange id). */
  key: string;
  mark: number | null;
  /** Index price (or Hyperliquid's oracle price). */
  index: number | null;
  /** Fraction per funding interval. */
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  /** One side, base units. */
  openInterest: number | null;
  /** Open interest in base units at the comparison time (snapshot nearest t − window). */
  openInterestBefore: number | null;
  /** Asset units per base unit; needed to add open interest across exchanges. */
  multiplier: number | null;
  /** 24 h traded value, quote currency. */
  turnover24h: number | null;
}

export interface PerpAggregate {
  /** Median of (mark − index) / index × 100 over legs with both prices. */
  premiumPct: number | null;
  /** Median of the funding rate normalised to 24 h, in percent. */
  funding24hPct: number | null;
  /** Lowest and highest 24 h funding, when at least two legs have funding. */
  fundingLow: { key: string; rate24hPct: number } | null;
  fundingHigh: { key: string; rate24hPct: number } | null;
  /** Σ open interest × mark (base units × price per base unit), quote currency. */
  openInterestUsd: number | null;
  /** Legs included in `openInterestUsd`. */
  oiKeys: string[];
  /**
   * Change of the summed open interest in asset units (base units × multiplier), over the legs
   * that have both values and a multiplier, so price moves and contract units do not count.
   */
  oiChangePct: number | null;
  /** Σ 24 h turnover, quote currency. */
  turnover24h: number | null;
}

const sum = (values: number[]): number | null => (values.length ? values.reduce((s, v) => s + v, 0) : null);

/** Cross-exchange summary of one asset's perpetuals. Legs without a value simply do not count. */
export function perpAggregate(legs: readonly PerpLeg[]): PerpAggregate {
  const premiums: number[] = [];
  const funding: { key: string; rate24hPct: number }[] = [];
  const notionals: number[] = [];
  const oiKeys: string[] = [];
  let oiNow = 0;
  let oiBefore = 0;
  let oiPairs = 0;
  const turnovers: number[] = [];

  for (const l of legs) {
    if (l.mark !== null && l.index !== null) {
      const p = pctDiff(l.mark, l.index);
      if (p !== null) premiums.push(p);
    }
    if (l.fundingRate !== null && l.fundingIntervalHours !== null) {
      const f = funding24h(l.fundingRate, l.fundingIntervalHours);
      if (f !== null) funding.push({ key: l.key, rate24hPct: f * 100 });
    }
    if (l.openInterest !== null && l.openInterest >= 0 && l.mark !== null && l.mark > 0) {
      notionals.push(l.openInterest * l.mark);
      oiKeys.push(l.key);
    }
    if (
      l.openInterest !== null &&
      l.openInterestBefore !== null &&
      l.openInterestBefore > 0 &&
      l.multiplier !== null &&
      l.multiplier > 0
    ) {
      oiNow += l.openInterest * l.multiplier;
      oiBefore += l.openInterestBefore * l.multiplier;
      oiPairs++;
    }
    if (l.turnover24h !== null && l.turnover24h >= 0) turnovers.push(l.turnover24h);
  }

  let low: { key: string; rate24hPct: number } | null = null;
  let high: { key: string; rate24hPct: number } | null = null;
  if (funding.length >= 2) {
    for (const f of funding) {
      if (!low || f.rate24hPct < low.rate24hPct) low = f;
      if (!high || f.rate24hPct > high.rate24hPct) high = f;
    }
  }

  return {
    premiumPct: median(premiums),
    funding24hPct: median(funding.map((f) => f.rate24hPct)),
    fundingLow: low,
    fundingHigh: high,
    openInterestUsd: sum(notionals),
    oiKeys,
    oiChangePct: oiPairs > 0 ? pctDiff(oiNow, oiBefore) : null,
    turnover24h: sum(turnovers),
  };
}
