import {
  readInstruments,
  readMarketSnapshots,
  readUniverse,
  withReaderFreshness,
  type Redis,
  type StoredInstruments,
} from '@mip/bus';
import type {
  ExchangeId,
  ExchangeMarketSnapshot,
  MarketsResponse,
  MarketTableRow,
  UniverseInfo,
} from '@mip/core';

export { SNAPSHOT_MAX_AGE_MS } from '@mip/bus';

export interface MarketSource {
  markets(exchange: ExchangeId): Promise<MarketsResponse>;
  universe(): Promise<UniverseInfo | null>;
}

/**
 * Joins a snapshot with instrument metadata and universe ranks. If the snapshot is too old,
 * every value is reported as stale rather than shown as if it were current.
 */
export function buildMarketsResponse(
  exchange: ExchangeId,
  raw: ExchangeMarketSnapshot | null,
  instruments: StoredInstruments | null,
  universe: UniverseInfo | null,
  now: number,
): MarketsResponse {
  const meta = new Map((instruments?.instruments[exchange] ?? []).map((i) => [i.symbol, i]));
  const ranks = new Map<string, { id: string; rank: number }>();
  for (const a of universe?.assets ?? []) {
    for (const i of a.instruments)
      if (i.exchange === exchange) ranks.set(i.symbol, { id: a.id, rank: a.rank });
  }
  const checked = raw ? withReaderFreshness(raw, now) : null;
  const rows: MarketTableRow[] = (checked?.snapshot.rows ?? []).map((r) => {
    const rank = ranks.get(r.symbol);
    return {
      symbol: r.symbol,
      fields: r.fields,
      assetId: rank?.id ?? null,
      assetRank: rank?.rank ?? null,
      instrument: meta.get(r.symbol) ?? null,
    };
  });
  rows.sort(
    (a, b) => (a.assetRank ?? Infinity) - (b.assetRank ?? Infinity) || a.symbol.localeCompare(b.symbol),
  );
  return {
    exchange,
    ts: raw?.ts ?? null,
    stale: checked?.stale ?? false,
    rows,
    capabilities: instruments?.capabilities[exchange] ?? null,
  };
}

export function createMarketSource(redis: Redis): MarketSource {
  return {
    async markets(exchange) {
      const [snapshots, instruments, universe] = await Promise.all([
        readMarketSnapshots(redis, [exchange]),
        readInstruments(redis),
        readUniverse(redis),
      ]);
      return buildMarketsResponse(exchange, snapshots[0] ?? null, instruments, universe, Date.now());
    },
    universe: () => readUniverse(redis),
  };
}
