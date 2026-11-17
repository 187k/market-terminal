import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, waitFor } from '../test-support/servers.js';
import {
  collectingSink,
  loadFixture,
  startReplayExchange,
  type ReplayExchange,
} from '../test-support/replay.js';
import { HyperliquidConnector } from './index.js';
import { lastTrade, nextHourlyFunding, parseAssetCtx, parseBbo, toInstrument } from './parse.js';

// Fixtures recorded from the live API with tools/record.mjs (2026-11-16).
const metaCtxs = loadFixture(import.meta.url, 'rest-meta-and-asset-ctxs');
const wsFx: Record<string, any[]> = loadFixture(import.meta.url, 'ws-0');

describe('Hyperliquid normalisation (recorded payloads)', () => {
  it('maps kPEPE to PEPE x1000, quoted in USDC, with an oracle instead of an index', () => {
    const pepe = toInstrument(metaCtxs[0].universe.find((u: any) => u.name === 'kPEPE'));
    expect(pepe).toMatchObject({
      symbol: 'kPEPE',
      asset: 'PEPE',
      multiplier: 1000,
      quote: 'USDC',
      indexKind: 'oracle',
    });
    expect(pepe.maxLeverage).toMatchObject({ available: true, value: 10 });
  });

  it('maps an asset context; funding is hourly and paid at the next full hour', () => {
    const now = Date.UTC(2026, 10, 16, 7, 26, 40);
    const ctx = wsFx.activeAssetCtx![0].data.ctx;
    expect(parseAssetCtx(ctx, now)).toEqual({
      mark: Number(ctx.markPx),
      index: Number(ctx.oraclePx),
      fundingRate: Number(ctx.funding),
      openInterest: Number(ctx.openInterest),
      turnover24h: Number(ctx.dayNtlVlm),
      fundingIntervalHours: 1,
      nextFundingTime: Date.UTC(2026, 10, 16, 8),
    });
    expect(nextHourlyFunding(Date.UTC(2026, 10, 16, 8))).toBe(Date.UTC(2026, 10, 16, 9));
  });

  it('maps best bid / offer, tolerating an empty side', () => {
    const d = wsFx.bbo![0].data;
    expect(parseBbo(d)).toEqual({
      ts: d.time,
      values: {
        bid: Number(d.bbo[0].px),
        bidSize: Number(d.bbo[0].sz),
        ask: Number(d.bbo[1].px),
        askSize: Number(d.bbo[1].sz),
      },
    });
    expect(parseBbo({ coin: 'X', time: 1, bbo: [null, { px: '2', sz: '3' }] }).values).toEqual({
      ask: 2,
      askSize: 3,
    });
  });

  it('takes the latest trade of a batch as the last price', () => {
    const batch = wsFx.trades![0].data;
    const t = lastTrade(batch)!;
    expect(t.coin).toBe('BTC');
    expect(t.time).toBe(Math.max(...batch.map((x: any) => x.time)));
    expect(lastTrade([])).toBeNull();
  });
});

describe('HyperliquidConnector against a local replay of recorded traffic', () => {
  let ex: ReplayExchange | null = null;
  let connector: HyperliquidConnector | null = null;
  afterEach(async () => {
    await connector?.stop();
    await ex?.close();
    connector = null;
    ex = null;
  });

  it('loads markets via POST /info, skips delisted coins and streams three channels per coin', async () => {
    const subs: string[] = [];
    ex = await startReplayExchange({
      rest: { '/info': metaCtxs },
      onMessage: (text, send) => {
        const msg = JSON.parse(text);
        if (msg.method === 'ping') return send({ channel: 'pong' });
        if (msg.method !== 'subscribe') return;
        const { type, coin } = msg.subscription;
        subs.push(`${type}|${coin}`);
        send({ channel: 'subscriptionResponse', data: msg });
        for (const m of wsFx[type] ?? []) {
          const c = Array.isArray(m.data) ? m.data[0]?.coin : m.data.coin;
          if (c === coin) send(m);
        }
      },
    });
    const rec = collectingSink();
    connector = new HyperliquidConnector(
      { logger: silentLogger, sink: rec.sink },
      { restUrl: ex.restUrl, wsUrl: ex.wsUrl },
    );
    const boot = await connector.loadMarkets();
    expect(boot.instruments.map((i) => i.symbol)).toEqual(['BTC', 'ETH', 'kPEPE']); // MATIC is delisted
    expect(ex.http.hits[0]).toMatchObject({ method: 'POST', path: '/info' });

    connector.setTracked(['BTC']);
    await connector.start();
    await waitFor(() => subs.length === 3, 3_000, 'three subscriptions');
    expect(subs.sort()).toEqual(['activeAssetCtx|BTC', 'bbo|BTC', 'trades|BTC']);
    await waitFor(
      () =>
        ['mark', 'bid', 'last'].every((f) => rec.updates.some((u) => u.symbol === 'BTC' && f in u.values)),
      3_000,
      'ctx, bbo and trade updates',
    );
  });
});
