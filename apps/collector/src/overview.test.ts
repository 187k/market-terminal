import { describe, expect, it, vi } from 'vitest';
import type { StoredMarketOverview } from '@mip/bus';
import { createLogger, type CoinSpotStats, type GlobalMarketStats, type UniverseInfo } from '@mip/core';
import { MarketOverviewPoller, overviewIds, type OverviewSource } from './overview.js';

const logger = createLogger({ service: 'test', level: 'silent' });

const universe = (source: UniverseInfo['source'], ids: string[]): UniverseInfo => ({
  source,
  builtAt: 0,
  size: ids.length,
  assets: ids.map((id, i) => ({
    id,
    symbol: id.toUpperCase(),
    name: id,
    rank: i + 1,
    marketCapRank: i + 1,
    marketCapUsd: null,
    priceUsd: null,
    instruments: [],
  })),
  problems: [],
  warnings: [],
});

// The poller only stores what the source returns; the shape of the figures does not matter here.
const coin = (id: string) => ({ id }) as CoinSpotStats;
const globalStats = { btcDominancePct: 57 } as GlobalMarketStats;

function setup(source: Partial<OverviewSource>) {
  const writes: StoredMarketOverview[] = [];
  let now = 1_000;
  const poller = new MarketOverviewPoller({
    source: {
      coinsByIds: source.coinsByIds ?? (async (ids) => ids.map(coin)),
      global: source.global ?? (async () => globalStats),
    },
    write: async (v) => void writes.push(v),
    logger,
    refreshMs: 120_000,
    now: () => now,
  });
  return { poller, writes, advance: (ms: number) => (now += ms) };
}

describe('overviewIds', () => {
  it('uses CoinGecko ids only from a CoinGecko-ranked universe', () => {
    expect(overviewIds(universe('coingecko', ['bitcoin', 'ethereum']))).toEqual(['bitcoin', 'ethereum']);
    expect(overviewIds(universe('volume', ['BTC']))).toBeNull();
    expect(overviewIds(null)).toBeNull();
  });
});

describe('MarketOverviewPoller', () => {
  it('fetches global stats before the universe exists, and coins once it does', async () => {
    const coinsByIds = vi.fn(async (ids: readonly string[]) => ids.map(coin));
    const { poller, writes } = setup({ coinsByIds });
    await poller.poll();
    expect(coinsByIds).not.toHaveBeenCalled();
    expect(writes.at(-1)).toMatchObject({ coins: null, global: { data: globalStats, fetchedAt: 1_000 } });

    poller.setUniverse(universe('coingecko', ['bitcoin', 'solana']));
    await poller.poll();
    expect(coinsByIds).toHaveBeenCalledWith(['bitcoin', 'solana']);
    expect(writes.at(-1)?.coins?.data.map((c) => c.id)).toEqual(['bitcoin', 'solana']);
    expect(writes.at(-1)?.refreshMs).toBe(120_000);
  });

  it('keeps the last good data and its time when a part fails, and records the error', async () => {
    let fail = false;
    const { poller, writes, advance } = setup({
      global: async () => {
        if (fail) throw new Error('HTTP 429');
        return globalStats;
      },
    });
    poller.setUniverse(universe('coingecko', ['bitcoin']));
    await poller.poll();
    fail = true;
    advance(120_000);
    await poller.poll();
    const last = writes.at(-1)!;
    expect(last.global).toEqual({ data: globalStats, fetchedAt: 1_000 });
    expect(last.globalError).toEqual({ message: 'HTTP 429', at: 121_000 });
    // The other part is unaffected.
    expect(last.coins?.fetchedAt).toBe(121_000);
    expect(last.coinsError).toBeNull();

    fail = false;
    advance(120_000);
    await poller.poll();
    expect(writes.at(-1)).toMatchObject({ global: { fetchedAt: 241_000 }, globalError: null });
  });

  it('never runs two polls at once', async () => {
    let release: () => void = () => undefined;
    const global = vi.fn(() => new Promise<GlobalMarketStats>((r) => (release = () => r(globalStats))));
    const { poller } = setup({ global });
    const a = poller.poll();
    const b = poller.poll();
    expect(a).toBe(b);
    release();
    await a;
    expect(global).toHaveBeenCalledTimes(1);
  });

  it('survives a failed Redis write', async () => {
    const poller = new MarketOverviewPoller({
      source: { coinsByIds: async () => [], global: async () => globalStats },
      write: async () => {
        throw new Error('redis down');
      },
      logger,
      refreshMs: 60_000,
    });
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(poller.state.global?.data).toBe(globalStats);
  });
});
