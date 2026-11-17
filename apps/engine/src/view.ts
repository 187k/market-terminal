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
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type Field,
  type InstrumentInfo,
  type MarketField,
  type UniverseAsset,
  type UniverseInfo,
} from '@mip/core';

/** One instrument as the scanners see it. */
export interface ViewRow {
  exchange: ExchangeId;
  symbol: string;
  instrument: InstrumentInfo | null;
  /** The universe asset this instrument represents (null if not mapped). */
  asset: UniverseAsset | null;
  fields: Record<MarketField, Field<number>>;
}

/** Everything the scanners need for one evaluation, read in one go. */
export interface MarketView {
  ts: number;
  rows: ViewRow[];
  /** Universe asset id -> its instruments on every exchange. */
  byAsset: Map<string, ViewRow[]>;
  universe: UniverseInfo | null;
  /** Exchanges whose snapshot is missing or older than the freshness limit. */
  staleExchanges: ExchangeId[];
}

/** Value of an available field, else null. */
export const val = (f: Field<number> | undefined): number | null => (f && f.available ? f.value : null);

export function buildView(
  snapshots: ExchangeMarketSnapshot[],
  instruments: StoredInstruments | null,
  universe: UniverseInfo | null,
  now: number,
): MarketView {
  const assetOf = new Map<string, UniverseAsset>();
  for (const a of universe?.assets ?? [])
    for (const i of a.instruments) assetOf.set(`${i.exchange}:${i.symbol}`, a);
  const rows: ViewRow[] = [];
  const byAsset = new Map<string, ViewRow[]>();
  const staleExchanges: ExchangeId[] = [];
  for (const raw of snapshots) {
    const { snapshot, stale } = withReaderFreshness(raw, now);
    if (stale) staleExchanges.push(raw.exchange);
    const meta = new Map((instruments?.instruments[raw.exchange] ?? []).map((i) => [i.symbol, i]));
    for (const r of snapshot.rows) {
      const asset = assetOf.get(`${raw.exchange}:${r.symbol}`) ?? null;
      const row: ViewRow = {
        exchange: raw.exchange,
        symbol: r.symbol,
        instrument: meta.get(r.symbol) ?? null,
        asset,
        fields: r.fields,
      };
      rows.push(row);
      if (asset) byAsset.set(asset.id, [...(byAsset.get(asset.id) ?? []), row]);
    }
  }
  return { ts: now, rows, byAsset, universe, staleExchanges };
}

export async function readView(redis: Redis, now = Date.now()): Promise<MarketView> {
  const [snapshots, instruments, universe] = await Promise.all([
    readMarketSnapshots(redis, EXCHANGE_IDS),
    readInstruments(redis),
    readUniverse(redis),
  ]);
  return buildView(snapshots, instruments, universe, now);
}
