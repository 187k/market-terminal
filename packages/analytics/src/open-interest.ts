import { pctDiff } from './basic.js';

export interface Sample {
  ts: number;
  value: number;
}

/**
 * The sample closest to `target` within `tolerance` ms, or null. Samples must be sorted by
 * time. Used for "value 30 minutes ago": without a sample near that time the change is
 * unknown, never interpolated.
 */
export function sampleAt(samples: readonly Sample[], target: number, tolerance: number): Sample | null {
  let best: Sample | null = null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.ts < target) lo = mid + 1;
    else hi = mid - 1;
  }
  for (const i of [lo - 1, lo]) {
    const s = samples[i];
    if (
      s &&
      Math.abs(s.ts - target) <= tolerance &&
      (!best || Math.abs(s.ts - target) < Math.abs(best.ts - target))
    )
      best = s;
  }
  return best;
}

export interface OiChange {
  current: number;
  previous: number;
  /** (current − previous) / previous × 100. */
  changePct: number;
  /** Change in base units (coins). */
  changeBase: number;
  /** Change in base units × current mark price. */
  changeUsd: number;
}

/**
 * OI change on base units, so price moves do not show up as OI moves. Returns null when the
 * previous value is not positive.
 */
export function oiChange(current: number, previous: number, mark: number): OiChange | null {
  const changePct = previous > 0 ? pctDiff(current, previous) : null;
  if (changePct === null) return null;
  const changeBase = current - previous;
  return { current, previous, changePct, changeBase, changeUsd: changeBase * mark };
}

export type OiScenario = 1 | 2 | 3 | 4;

export const OI_SCENARIOS: Record<OiScenario, { label: string; reading: string }> = {
  1: {
    label: 'Price ↑ + OI ↑',
    reading: 'New positions are opened as price rises; buyers are the more aggressive side.',
  },
  2: {
    label: 'Price ↓ + OI ↑',
    reading: 'New positions are opened as price falls; sellers are the more aggressive side.',
  },
  3: {
    label: 'Price ↑ + OI ↓',
    reading: 'Positions are closed as price rises; consistent with shorts covering.',
  },
  4: {
    label: 'Price ↓ + OI ↓',
    reading: 'Positions are closed as price falls; consistent with longs exiting.',
  },
};

/** The four specified scenarios; null when either change is exactly zero. */
export function oiScenario(priceChangePct: number, oiChangePct: number): OiScenario | null {
  if (priceChangePct === 0 || oiChangePct === 0) return null;
  if (oiChangePct > 0) return priceChangePct > 0 ? 1 : 2;
  return priceChangePct > 0 ? 3 : 4;
}
