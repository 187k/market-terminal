import {
  readInstruments,
  readMarketSnapshots,
  readUniverse,
  withReaderFreshness,
  type Redis,
  type StoredInstruments,
} from '@mip/bus';
import {
  EXCHANGE_IDS,
  type AssetDetailResponse,
  type AssetHistorySeries,
  type AssetMarketRow,
  type ExchangeCapabilities,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type UniverseInfo,
} from '@mip/core';
import type { PrismaClient } from '@mip/db';
import type { ScannerSource } from './scanners.js';

/** Asset codes as the connectors produce them (e.g. "BTC", "1INCH", "PEPE"). */
export const isAssetCode = (v: string): boolean => /^[A-Za-z0-9._-]{1,30}$/.test(v);

export const ASSET_HISTORY_HOURS = 24;
export const ASSET_HISTORY_STEP_MINUTES = 15;
/** Minute snapshots change once a minute; re-reading them on every push would only load Postgres. */
const HISTORY_CACHE_MS = 60_000;
const RECENT_SIGNALS = 30;

export interface AssetSource {
  asset(code: string): Promise<AssetDetailResponse>;
}

/** The asset's instruments: the universe mapping when the asset is monitored, else the instrument metadata. */
export function assetInstruments(
  code: string,
  instruments: StoredInstruments | null,
  universe: UniverseInfo | null,
): { exchange: ExchangeId; symbol: string }[] {
  const entry = universe?.assets.find((a) => a.symbol === code);
  if (entry) return entry.instruments;
  const out: { exchange: ExchangeId; symbol: string }[] = [];
  for (const ex of EXCHANGE_IDS)
    for (const i of instruments?.instruments[ex] ?? [])
      if (i.asset === code) out.push({ exchange: ex, symbol: i.symbol });
  return out;
}

/**
 * Current values of one asset on every exchange. A snapshot older than the reader limit marks
 * that exchange stale and every value in it as stale, exactly like the market table.
 */
export function buildAssetRows(
  code: string,
  snapshots: (ExchangeMarketSnapshot | null)[],
  instruments: StoredInstruments | null,
  universe: UniverseInfo | null,
  now: number,
): Pick<AssetDetailResponse, 'universe' | 'rows' | 'staleExchanges' | 'capabilities'> {
  const entry = universe?.assets.find((a) => a.symbol === code) ?? null;
  const wanted = assetInstruments(code, instruments, universe);
  const rows: AssetMarketRow[] = [];
  const staleExchanges: ExchangeId[] = [];
  const capabilities: Partial<Record<ExchangeId, ExchangeCapabilities>> = {};
  for (const raw of snapshots) {
    if (!raw) continue;
    const symbols = new Set(wanted.filter((w) => w.exchange === raw.exchange).map((w) => w.symbol));
    if (symbols.size === 0) continue;
    const checked = withReaderFreshness(raw, now);
    if (checked.stale) staleExchanges.push(raw.exchange);
    const caps = instruments?.capabilities[raw.exchange];
    if (caps) capabilities[raw.exchange] = caps;
    for (const r of checked.snapshot.rows) {
      if (!symbols.has(r.symbol)) continue;
      rows.push({
        exchange: raw.exchange,
        symbol: r.symbol,
        fields: r.fields,
        assetId: entry?.id ?? null,
        assetRank: entry?.rank ?? null,
        instrument: instruments?.instruments[raw.exchange]?.find((i) => i.symbol === r.symbol) ?? null,
      });
    }
  }
  rows.sort((a, b) => EXCHANGE_IDS.indexOf(a.exchange) - EXCHANGE_IDS.indexOf(b.exchange));
  return { universe: entry, rows, staleExchanges, capabilities };
}

/** Keeps every `stepMinutes`-th minute snapshot (aligned to the clock) so a day fits in a sparkline. */
export function sampleHistory<T extends { ts: number }>(points: T[], stepMinutes: number): T[] {
  const step = stepMinutes * 60_000;
  return points.filter((p) => p.ts % step === 0);
}

export function createAssetSource(redis: Redis, prisma: PrismaClient, scanners: ScannerSource): AssetSource {
  const historyCache = new Map<string, { at: number; series: AssetHistorySeries[] }>();

  const history = async (
    code: string,
    instruments: { exchange: ExchangeId; symbol: string }[],
    now: number,
  ): Promise<AssetHistorySeries[]> => {
    const cached = historyCache.get(code);
    if (cached && now - cached.at < HISTORY_CACHE_MS) return cached.series;
    if (instruments.length === 0) return [];
    const rows = await prisma.marketSnapshot.findMany({
      where: {
        OR: instruments.map((i) => ({ exchange: i.exchange, symbol: i.symbol })),
        ts: { gte: new Date(now - ASSET_HISTORY_HOURS * 3_600_000) },
      },
      orderBy: { ts: 'asc' },
      select: { ts: true, exchange: true, symbol: true, mark: true, openInterest: true, fundingRate: true },
    });
    const byInstrument = new Map<string, AssetHistorySeries>();
    for (const i of instruments)
      byInstrument.set(`${i.exchange}:${i.symbol}`, { exchange: i.exchange, symbol: i.symbol, points: [] });
    for (const r of rows) {
      byInstrument.get(`${r.exchange}:${r.symbol}`)?.points.push({
        ts: r.ts.getTime(),
        mark: r.mark,
        openInterest: r.openInterest,
        fundingRate: r.fundingRate,
      });
    }
    const series = [...byInstrument.values()]
      .map((s) => ({ ...s, points: sampleHistory(s.points, ASSET_HISTORY_STEP_MINUTES) }))
      .filter((s) => s.points.length > 0);
    // Bounded: one entry per asset someone has opened recently.
    if (historyCache.size > 200) historyCache.clear();
    historyCache.set(code, { at: now, series });
    return series;
  };

  return {
    async asset(code) {
      const now = Date.now();
      const [snapshots, instruments, universe] = await Promise.all([
        readMarketSnapshots(redis, [...EXCHANGE_IDS]),
        readInstruments(redis),
        readUniverse(redis),
      ]);
      const live = buildAssetRows(code, snapshots, instruments, universe, now);
      const [active, recent, series] = await Promise.all([
        scanners.signals({ status: 'active', asset: code, limit: 100 }),
        scanners.signals({ status: 'resolved', asset: code, limit: RECENT_SIGNALS }),
        history(code, assetInstruments(code, instruments, universe), now),
      ]);
      return {
        asset: code,
        ...live,
        active,
        recent,
        history: series,
        historyHours: ASSET_HISTORY_HOURS,
        historyStepMinutes: ASSET_HISTORY_STEP_MINUTES,
        ts: now,
      };
    },
  };
}
