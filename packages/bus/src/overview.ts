import type { CoinSpotStats, GlobalMarketStats } from '@mip/core';
import { KEYS } from './keys.js';
import type { Redis } from './redis.js';

/**
 * The collector's latest CoinGecko results for the home page. Each part keeps the last
 * successful fetch with its time, plus the last error, so a failed poll shows old data as old
 * instead of hiding it or presenting it as current.
 */
export interface StoredMarketOverview {
  coins: { data: CoinSpotStats[]; fetchedAt: number } | null;
  coinsError: { message: string; at: number } | null;
  global: { data: GlobalMarketStats; fetchedAt: number } | null;
  globalError: { message: string; at: number } | null;
  /** The collector's poll interval; readers call data stale after a few missed polls. */
  refreshMs: number;
}

/**
 * Kept for a while after the collector stops, so the home page can show the last figures as
 * stale (with their age) rather than nothing; readers judge staleness from `fetchedAt`.
 */
const OVERVIEW_TTL_MS = 6 * 3_600_000;

export async function writeMarketOverview(redis: Redis, value: StoredMarketOverview): Promise<void> {
  await redis.set(KEYS.marketOverview, JSON.stringify(value), 'PX', OVERVIEW_TTL_MS);
}

export async function readMarketOverview(redis: Redis): Promise<StoredMarketOverview | null> {
  const raw = await redis.get(KEYS.marketOverview);
  return raw ? (JSON.parse(raw) as StoredMarketOverview) : null;
}
