import { afterEach, describe, expect, it } from 'vitest';
import { loadFixture } from '../test-support/replay.js';
import { json, silentLogger, startHttpServer, type TestHttpServer } from '../test-support/servers.js';
import { CoinGeckoClient, parseCoinMarkets, parseCoinSpot, parseGlobal } from './index.js';

// Recorded from the keyless public API on 2026-11-21 (tools/record-coingecko.mjs): bitcoin,
// ethereum and solana with the 7-day sparkline, and /global (BTC ≈ 58,400, total cap ≈ 2.0 T).
const markets = loadFixture<unknown[]>(import.meta.url, 'markets');
const global = loadFixture<unknown>(import.meta.url, 'global');

describe('CoinGecko parsing (recorded payloads)', () => {
  it('normalises /coins/markets rows', () => {
    const coins = parseCoinMarkets(markets);
    expect(coins.map((c) => c.id)).toEqual(['bitcoin', 'ethereum', 'solana']);
    const btc = coins[0]!;
    expect(btc.symbol).toBe('BTC');
    expect(btc.name).toBe('Bitcoin');
    expect(btc.priceUsd).toBeGreaterThan(50_000);
    expect(btc.priceUsd).toBeLessThan(70_000);
    expect(btc.marketCapRank).toBe(1);
    expect(btc.marketCapUsd).toBeGreaterThan(1e12);
    expect(btc.volume24hUsd).toBeGreaterThan(0);
    expect(btc.low24hUsd!).toBeLessThanOrEqual(btc.priceUsd!);
    expect(btc.high24hUsd!).toBeGreaterThanOrEqual(btc.priceUsd!);
    expect(btc.maxSupply).toBe(21_000_000);
    expect(btc.athAt).toBe(Date.parse('2025-10-06T10:57:42.000Z'));
    expect(btc.updatedAt).toBe(Date.parse('2026-11-20T21:01:51.000Z'));
    for (const c of coins) {
      expect(c.change1hPct).not.toBeNull();
      expect(c.change24hPct).not.toBeNull();
      expect(c.change7dPct).not.toBeNull();
      // Hourly over 7 days.
      expect(c.sparkline7d).toHaveLength(168);
    }
  });

  it('uses the plain 24 h change when the _in_currency field is missing', () => {
    const row = { ...(markets[0] as Record<string, unknown>) };
    delete row.price_change_percentage_24h_in_currency;
    expect(parseCoinSpot(row)?.change24hPct).toBe(row.price_change_percentage_24h);
  });

  it('reports missing or non-positive values as null and never fills them', () => {
    const row = {
      ...(markets[0] as Record<string, unknown>),
      current_price: null,
      max_supply: 0,
      market_cap: 'n/a',
      price_change_percentage_7d_in_currency: undefined,
    };
    const c = parseCoinSpot(row)!;
    expect(c.priceUsd).toBeNull();
    expect(c.maxSupply).toBeNull();
    expect(c.marketCapUsd).toBeNull();
    expect(c.change7dPct).toBeNull();
  });

  it('drops a sparkline with an invalid point instead of closing the gap', () => {
    const row = markets[1] as { sparkline_in_7d: { price: unknown[] } };
    const broken = { ...row, sparkline_in_7d: { price: [...row.sparkline_in_7d.price.slice(0, 5), null] } };
    expect(parseCoinSpot(broken)?.sparkline7d).toEqual([]);
  });

  it('skips rows without an id', () => {
    expect(parseCoinMarkets([{ symbol: 'x' }, markets[2]])).toHaveLength(1);
    expect(() => parseCoinMarkets({ error: 'x' })).toThrow();
  });

  it('normalises /global', () => {
    const g = parseGlobal(global);
    expect(g.totalMarketCapUsd).toBeGreaterThan(1e12);
    expect(g.totalVolume24hUsd).toBeGreaterThan(1e10);
    expect(g.btcDominancePct).toBeGreaterThan(40);
    expect(g.btcDominancePct).toBeLessThan(70);
    expect(g.ethDominancePct).toBeGreaterThan(0);
    expect(g.marketCapChange24hPct).not.toBeNull();
    expect(g.activeCryptocurrencies).toBeGreaterThan(1_000);
    expect(g.markets).toBeGreaterThan(100);
    expect(g.updatedAt).toBe(Date.parse('2026-11-20T20:59:00.000Z'));
    expect(g.fearGreed).toEqual({ value: 22, label: 'extreme fear' });
  });

  it('leaves the undocumented Fear & Greed reading out when CoinGecko stops sending it', () => {
    const data = { ...(global as { data: Record<string, unknown> }).data };
    delete data.fear_and_greed_index;
    expect(parseGlobal({ data }).fearGreed).toBeNull();
    expect(() => parseGlobal({ status: 'x' })).toThrow();
  });
});

describe('CoinGeckoClient overview requests', () => {
  let server: TestHttpServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('requests sparklines and changes for the given ids, in chunks of 250', async () => {
    server = await startHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/api/v3/global') return json(res, 200, global);
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      json(
        res,
        200,
        markets.filter((m) => ids.includes((m as { id: string }).id)),
      );
    });
    const client = new CoinGeckoClient({ logger: silentLogger, baseUrl: server.baseUrl });
    const ids = ['bitcoin', ...Array.from({ length: 260 }, (_, i) => `coin-${i}`), 'solana'];
    const coins = await client.coinsByIds(ids);
    expect(coins.map((c) => c.id)).toEqual(['bitcoin', 'solana']);
    expect(server.hits).toHaveLength(2);
    const first = new URL(server.hits[0]!.path, 'http://x').searchParams;
    expect(first.get('ids')!.split(',')).toHaveLength(250);
    expect(first.get('sparkline')).toBe('true');
    expect(first.get('price_change_percentage')).toBe('1h,24h,7d');
    expect(first.get('vs_currency')).toBe('usd');
    expect((await client.global()).btcDominancePct).toBeGreaterThan(40);
  });

  it('does not retry a failed overview request (the next poll is the retry)', async () => {
    server = await startHttpServer((_req, res) => json(res, 500, { error: 'boom' }));
    const client = new CoinGeckoClient({ logger: silentLogger, baseUrl: server.baseUrl });
    await expect(client.global()).rejects.toThrow();
    expect(server.hits).toHaveLength(1);
  });
});
