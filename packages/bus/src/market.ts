import {
  unavailable,
  type ExchangeCapabilities,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type Field,
  type InstrumentInfo,
  type MarketField,
  type UniverseInfo,
} from '@mip/core';
import { KEYS } from './keys.js';
import type { Redis } from './redis.js';

/** Snapshots expire if the collector stops publishing; readers also check `ts` themselves. */
const MARKET_TTL_MS = 60_000;

/** The collector publishes every second; an older snapshot means it has stopped. */
export const SNAPSHOT_MAX_AGE_MS = 5_000;

/**
 * Applies the reader-side freshness rule: if the collector has not published for
 * SNAPSHOT_MAX_AGE_MS, every available value is reported as stale instead of current.
 * Used by every process that reads market snapshots, so the rule exists once.
 */
export function withReaderFreshness(
  snapshot: ExchangeMarketSnapshot,
  now: number,
): { snapshot: ExchangeMarketSnapshot; stale: boolean } {
  if (now - snapshot.ts <= SNAPSHOT_MAX_AGE_MS) return { snapshot, stale: false };
  const stale = unavailable('stale', 'collector stopped publishing');
  return {
    stale: true,
    snapshot: {
      ...snapshot,
      rows: snapshot.rows.map((r) => ({
        symbol: r.symbol,
        fields: Object.fromEntries(
          Object.entries(r.fields).map(([k, f]) => [k, f.available ? stale : f]),
        ) as Record<MarketField, Field<number>>,
      })),
    },
  };
}

export async function writeMarketSnapshots(redis: Redis, snapshots: ExchangeMarketSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return;
  const pipe = redis.multi();
  for (const s of snapshots) pipe.set(KEYS.market(s.exchange), JSON.stringify(s), 'PX', MARKET_TTL_MS);
  await pipe.exec();
}

export async function readMarketSnapshots(
  redis: Redis,
  exchanges: readonly ExchangeId[],
): Promise<ExchangeMarketSnapshot[]> {
  if (exchanges.length === 0) return [];
  const raw = await redis.mget(...exchanges.map((e) => KEYS.market(e)));
  return raw.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as ExchangeMarketSnapshot);
}

export interface StoredInstruments {
  ts: number;
  instruments: Partial<Record<ExchangeId, InstrumentInfo[]>>;
  capabilities: Partial<Record<ExchangeId, ExchangeCapabilities>>;
}

export async function writeInstruments(redis: Redis, value: StoredInstruments): Promise<void> {
  await redis.set(KEYS.instruments, JSON.stringify(value));
}

export async function readInstruments(redis: Redis): Promise<StoredInstruments | null> {
  const raw = await redis.get(KEYS.instruments);
  return raw ? (JSON.parse(raw) as StoredInstruments) : null;
}

/**
 * Records that an exchange paused us until `untilMs`, so a restarted collector keeps waiting
 * instead of sending a request into an active ban (which extends it). Expires with the pause.
 */
export async function writeRestPause(redis: Redis, exchange: ExchangeId, untilMs: number): Promise<void> {
  const ttl = untilMs - Date.now();
  if (ttl > 0) await redis.set(KEYS.restPause(exchange), String(untilMs), 'PX', ttl);
}

export async function readRestPauses(
  redis: Redis,
  exchanges: readonly ExchangeId[],
): Promise<Partial<Record<ExchangeId, number>>> {
  if (exchanges.length === 0) return {};
  const raw = await redis.mget(...exchanges.map((e) => KEYS.restPause(e)));
  const out: Partial<Record<ExchangeId, number>> = {};
  exchanges.forEach((e, i) => {
    const until = Number(raw[i]);
    if (raw[i] && until > Date.now()) out[e] = until;
  });
  return out;
}

export async function writeUniverse(redis: Redis, universe: UniverseInfo): Promise<void> {
  await redis.set(KEYS.universe, JSON.stringify(universe));
}

export async function readUniverse(redis: Redis): Promise<UniverseInfo | null> {
  const raw = await redis.get(KEYS.universe);
  return raw ? (JSON.parse(raw) as UniverseInfo) : null;
}
