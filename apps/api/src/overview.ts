import {
  readInstruments,
  readMarketOverview,
  readMarketSnapshots,
  readUniverse,
  withReaderFreshness,
  type Redis,
  type StoredInstruments,
  type StoredMarketOverview,
} from '@mip/bus';
import { median, perpAggregate, sampleAt, type PerpLeg, type Sample } from '@mip/analytics';
import {
  EXCHANGE_IDS,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type Field,
  type MarketOverviewResponse,
  type PerpOverviewResponse,
  type PerpSummary,
  type UniverseInfo,
} from '@mip/core';
import type { PrismaClient } from '@mip/db';

/** CoinGecko figures count as stale after this many missed collector polls. */
export const OVERVIEW_STALE_POLLS = 3;
/** Used before the collector has stored anything (its default poll interval). */
const DEFAULT_REFRESH_MS = 120_000;

/** OI 24 h change: compared with the minute snapshot nearest 24 h ago, if one is this close. */
export const OI_BASELINE_HOURS = 24;
export const OI_BASELINE_TOLERANCE_MS = 10 * 60_000;
/** Minute snapshots change once a minute; reading them on every push would only load Postgres. */
const BASELINE_CACHE_MS = 60_000;

export interface OverviewSource {
  overview(): Promise<MarketOverviewResponse>;
  perps(): Promise<PerpOverviewResponse>;
}

/**
 * The universe's coins in rank order with their CoinGecko figures (joined by CoinGecko id,
 * never by ticker), plus the global stats, each with its fetch time and a stale flag.
 */
export function buildOverviewResponse(
  stored: StoredMarketOverview | null,
  universe: UniverseInfo | null,
  now: number,
): MarketOverviewResponse {
  const staleAfterMs = (stored?.refreshMs ?? DEFAULT_REFRESH_MS) * OVERVIEW_STALE_POLLS;
  const isStale = (at: number | null) => at !== null && now - at > staleAfterMs;
  const notes: string[] = [];

  const byId = new Map((stored?.coins?.data ?? []).map((c) => [c.id, c]));
  const coinsUsable = universe?.source === 'coingecko';
  const coins = (universe?.assets ?? []).map((a) => ({
    asset: a.symbol,
    name: a.name,
    rank: a.rank,
    spot: coinsUsable ? (byId.get(a.id) ?? null) : null,
  }));

  if (!stored)
    notes.push('No CoinGecko data yet: the collector has not finished its first poll, or it is not running.');
  if (!universe) notes.push('The monitored universe is not built yet, so there are no coins to show.');
  else if (!coinsUsable)
    notes.push(
      'The universe is ranked by perpetual turnover (CoinGecko unavailable or UNIVERSE_RANKING=volume), so CoinGecko coin figures cannot be matched.',
    );
  if (stored?.coinsError)
    notes.push(
      `The last CoinGecko request for coin figures failed (${stored.coinsError.message})${stored.coins ? '; showing the previous figures' : ''}.`,
    );
  if (stored?.globalError)
    notes.push(
      `The last CoinGecko request for global market figures failed (${stored.globalError.message})${stored.global ? '; showing the previous figures' : ''}.`,
    );
  const missing =
    coinsUsable && stored?.coins ? coins.filter((c) => c.spot === null).map((c) => c.asset) : [];
  if (missing.length > 0)
    notes.push(
      `CoinGecko returned no figures for ${missing.length === 1 ? '' : `${missing.length} coins: `}${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}.`,
    );

  const coinsFetchedAt = stored?.coins?.fetchedAt ?? null;
  const globalFetchedAt = stored?.global?.fetchedAt ?? null;
  return {
    source: 'coingecko',
    coins,
    coinsFetchedAt,
    coinsStale: isStale(coinsFetchedAt),
    global: stored?.global?.data ?? null,
    globalFetchedAt,
    globalStale: isStale(globalFetchedAt),
    staleAfterMs,
    notes,
  };
}

const fresh = (f: Field<number> | undefined): number | null => (f?.available ? f.value : null);

/** Open interest (base units) per instrument at the baseline time, keyed `exchange:symbol`. */
export type OiBaseline = Map<string, number>;

/**
 * Cross-exchange perpetual figures per universe asset from the collector's snapshots. A
 * snapshot older than the reader limit marks its exchange stale and contributes nothing.
 */
export function buildPerpOverview(
  snapshots: (ExchangeMarketSnapshot | null)[],
  instruments: StoredInstruments | null,
  universe: UniverseInfo | null,
  baseline: { at: number | null; oi: OiBaseline },
  now: number,
): PerpOverviewResponse {
  const rows = new Map<string, ExchangeMarketSnapshot['rows'][number]['fields']>();
  const staleExchanges: ExchangeId[] = [];
  for (const raw of snapshots) {
    if (!raw) continue;
    const checked = withReaderFreshness(raw, now);
    if (checked.stale) {
      staleExchanges.push(raw.exchange);
      continue;
    }
    for (const r of checked.snapshot.rows) rows.set(`${raw.exchange}:${r.symbol}`, r.fields);
  }
  const multipliers = new Map<string, number>();
  for (const ex of EXCHANGE_IDS)
    for (const i of instruments?.instruments[ex] ?? []) multipliers.set(`${ex}:${i.symbol}`, i.multiplier);

  const assets: PerpSummary[] = [];
  for (const a of universe?.assets ?? []) {
    const legs: PerpLeg[] = [];
    const venues = new Set<ExchangeId>();
    for (const inst of a.instruments) {
      const key = `${inst.exchange}:${inst.symbol}`;
      const f = rows.get(key);
      if (!f) continue;
      const leg: PerpLeg = {
        key: inst.exchange,
        mark: fresh(f.mark),
        index: fresh(f.index),
        fundingRate: fresh(f.fundingRate),
        fundingIntervalHours: fresh(f.fundingIntervalHours),
        openInterest: fresh(f.openInterest),
        openInterestBefore: baseline.oi.get(key) ?? null,
        multiplier: multipliers.get(key) ?? null,
        turnover24h: fresh(f.turnover24h),
      };
      if (
        leg.mark !== null ||
        leg.fundingRate !== null ||
        leg.openInterest !== null ||
        leg.turnover24h !== null
      )
        venues.add(inst.exchange);
      legs.push(leg);
    }
    const agg = perpAggregate(legs);
    assets.push({
      asset: a.symbol,
      venues: EXCHANGE_IDS.filter((ex) => venues.has(ex)),
      premiumPct: agg.premiumPct,
      funding24hPct: agg.funding24hPct,
      fundingLow: agg.fundingLow
        ? { exchange: agg.fundingLow.key as ExchangeId, rate24hPct: agg.fundingLow.rate24hPct }
        : null,
      fundingHigh: agg.fundingHigh
        ? { exchange: agg.fundingHigh.key as ExchangeId, rate24hPct: agg.fundingHigh.rate24hPct }
        : null,
      openInterestUsd: agg.openInterestUsd,
      oiVenues: EXCHANGE_IDS.filter((ex) => agg.oiKeys.includes(ex)),
      oiChange24hPct: agg.oiChangePct,
      turnover24hUsd: agg.turnover24h,
    });
  }

  const known = (pick: (s: PerpSummary) => number | null) =>
    assets.map(pick).filter((v): v is number => v !== null);
  const total = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) : null);
  return {
    assets,
    totals: {
      openInterestUsd: total(known((s) => s.openInterestUsd)),
      turnover24hUsd: total(known((s) => s.turnover24hUsd)),
      funding24hPct: median(known((s) => s.funding24hPct)),
    },
    staleExchanges,
    oiBaselineAt: baseline.at,
  };
}

/**
 * Picks, per instrument, the snapshot nearest `target` within the tolerance (never
 * interpolated). Rows must be sorted by time.
 */
export function pickBaseline(
  rows: { ts: number; exchange: string; symbol: string; openInterest: number | null }[],
  target: number,
  tolerance: number,
): { at: number | null; oi: OiBaseline } {
  const series = new Map<string, Sample[]>();
  for (const r of rows) {
    if (r.openInterest === null) continue;
    const key = `${r.exchange}:${r.symbol}`;
    let s = series.get(key);
    if (!s) series.set(key, (s = []));
    s.push({ ts: r.ts, value: r.openInterest });
  }
  const oi: OiBaseline = new Map();
  let at: number | null = null;
  for (const [key, samples] of series) {
    const hit = sampleAt(samples, target, tolerance);
    if (!hit) continue;
    oi.set(key, hit.value);
    if (at === null || Math.abs(hit.ts - target) < Math.abs(at - target)) at = hit.ts;
  }
  return { at, oi };
}

export function createOverviewSource(redis: Redis, prisma: PrismaClient): OverviewSource {
  let cached: { at: number; value: { at: number | null; oi: OiBaseline } } | null = null;

  const baseline = async (now: number) => {
    if (cached && now - cached.at < BASELINE_CACHE_MS) return cached.value;
    const target = now - OI_BASELINE_HOURS * 3_600_000;
    const rows = await prisma.marketSnapshot.findMany({
      where: {
        ts: {
          gte: new Date(target - OI_BASELINE_TOLERANCE_MS),
          lte: new Date(target + OI_BASELINE_TOLERANCE_MS),
        },
        openInterest: { not: null },
      },
      orderBy: { ts: 'asc' },
      select: { ts: true, exchange: true, symbol: true, openInterest: true },
    });
    const value = pickBaseline(
      rows.map((r) => ({ ...r, ts: r.ts.getTime() })),
      target,
      OI_BASELINE_TOLERANCE_MS,
    );
    cached = { at: now, value };
    return value;
  };

  return {
    async overview() {
      const [stored, universe] = await Promise.all([readMarketOverview(redis), readUniverse(redis)]);
      return buildOverviewResponse(stored, universe, Date.now());
    },
    async perps() {
      const now = Date.now();
      const [snapshots, instruments, universe, base] = await Promise.all([
        readMarketSnapshots(redis, [...EXCHANGE_IDS]),
        readInstruments(redis),
        readUniverse(redis),
        baseline(now),
      ]);
      return buildPerpOverview(snapshots, instruments, universe, base, now);
    },
  };
}
