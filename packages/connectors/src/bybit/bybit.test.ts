import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, waitFor } from '../test-support/servers.js';
import {
  collectingSink,
  loadFixture,
  startReplayExchange,
  type ReplayExchange,
} from '../test-support/replay.js';
import { BybitConnector } from './index.js';
import { isCryptoUsdtPerp, parseTicker, toInstrument, type BybitInstrument } from './parse.js';

// Fixtures recorded from the live API with tools/record.mjs (2026-11-16).
const instrumentsFx = loadFixture(import.meta.url, 'rest-instruments');
const tickersFx = loadFixture(import.meta.url, 'rest-tickers');
const wsFx: Record<string, any[]> = loadFixture(import.meta.url, 'ws-0');

describe('Bybit normalisation (recorded payloads)', () => {
  it('maps instruments, including the multiplier prefix', () => {
    const list: BybitInstrument[] = instrumentsFx.result.list;
    const pepe = toInstrument(list.find((i) => i.symbol === '1000PEPEUSDT')!);
    expect(pepe).toMatchObject({
      exchange: 'bybit',
      symbol: '1000PEPEUSDT',
      base: '1000PEPE',
      asset: 'PEPE',
      multiplier: 1000,
      quote: 'USDT',
      contractSize: 1,
      tickSize: 0.000001,
      indexKind: 'index',
      launchTime: 1683108271000,
      url: 'https://www.bybit.com/trade/usdt/1000PEPEUSDT',
    });
    expect(pepe.maxLeverage).toMatchObject({ available: true, value: 75 });
  });

  it('keeps crypto USDT perpetuals and drops stocks, futures and USDC contracts', () => {
    const base = instrumentsFx.result.list[0] as BybitInstrument;
    expect(isCryptoUsdtPerp(base)).toBe(true);
    expect(isCryptoUsdtPerp({ ...base, symbolType: 'innovation' })).toBe(true);
    expect(isCryptoUsdtPerp({ ...base, symbolType: 'stock' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...base, symbolType: 'ETF' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...base, contractType: 'LinearFutures' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...base, quoteCoin: 'USDC', settleCoin: 'USDC' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...base, status: 'PreLaunch' })).toBe(false);
  });

  it('maps a REST ticker; open interest is the one-sided figure', () => {
    const btc = tickersFx.result.list.find((t: any) => t.symbol === 'BTCUSDT');
    const v = parseTicker(btc);
    expect(v.openInterest).toBe(Number(btc.singleOpenInterest));
    expect(v.openInterest).toBeCloseTo(Number(btc.openInterest) / 2, 0);
    expect(v).toMatchObject({
      last: Number(btc.lastPrice),
      mark: Number(btc.markPrice),
      index: Number(btc.indexPrice),
      bid: Number(btc.bid1Price),
      ask: Number(btc.ask1Price),
      bidSize: Number(btc.bid1Size),
      askSize: Number(btc.ask1Size),
      fundingRate: Number(btc.fundingRate),
      fundingIntervalHours: 8,
      nextFundingTime: Number(btc.nextFundingTime),
      turnover24h: Number(btc.turnover24h),
    });
  });

  it('returns only the fields present in a WS delta (missing = unchanged)', () => {
    const delta = wsFx['tickers.BTCUSDT:delta']![0].data;
    expect(Object.keys(parseTicker(delta)).sort()).toEqual(
      Object.keys(delta)
        .filter((k) => k !== 'symbol')
        .map((k) => ({ bid1Price: 'bid', bid1Size: 'bidSize', ask1Price: 'ask', ask1Size: 'askSize' })[k])
        .sort(),
    );
  });

  it('ignores empty strings instead of turning them into zeros', () => {
    expect(parseTicker({ lastPrice: '', markPrice: '1.5', basis: '' })).toEqual({ mark: 1.5 });
  });
});

describe('BybitConnector against a local replay of recorded traffic', () => {
  let ex: ReplayExchange | null = null;
  let connector: BybitConnector | null = null;
  afterEach(async () => {
    await connector?.stop();
    await ex?.close();
    connector = null;
    ex = null;
  });

  async function setup() {
    const subscribes: string[][] = [];
    ex = await startReplayExchange({
      rest: { '/v5/market/instruments-info': instrumentsFx, '/v5/market/tickers': tickersFx },
      onMessage: (text, send) => {
        const msg = JSON.parse(text);
        if (msg.op === 'ping') return send({ op: 'pong' });
        if (msg.op !== 'subscribe') return;
        subscribes.push(msg.args);
        send({ success: true, ret_msg: '', op: 'subscribe' });
        for (const topic of msg.args as string[]) {
          for (const m of wsFx[`${topic}:snapshot`] ?? []) send(m);
          for (const m of wsFx[`${topic}:delta`] ?? []) send(m);
        }
      },
    });
    const rec = collectingSink();
    connector = new BybitConnector(
      { logger: silentLogger, sink: rec.sink },
      { restUrl: ex.restUrl, wsUrl: ex.wsUrl },
    );
    return { rec, subscribes };
  }

  it('loads markets, streams tracked symbols and normalises snapshot + deltas', async () => {
    const { rec, subscribes } = await setup();
    const boot = await connector!.loadMarkets();
    expect(boot.instruments.map((i) => i.symbol).sort()).toEqual(['1000PEPEUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(boot.updates).toHaveLength(3);
    expect(boot.updates.every((u) => u.connection === null && u.exchangeTs === tickersFx.time)).toBe(true);

    connector!.setTracked(['BTCUSDT', 'ETHUSDT']);
    await connector!.start();
    await waitFor(() => rec.updates.filter((u) => u.symbol === 'ETHUSDT').length >= 5, 3_000, 'ETH updates');
    expect(subscribes[0]).toEqual(['tickers.BTCUSDT', 'tickers.ETHUSDT']);

    const btc = rec.updates.filter((u) => u.symbol === 'BTCUSDT');
    expect(btc[0]!.values.mark).toBe(Number(wsFx['tickers.BTCUSDT:snapshot']![0].data.markPrice));
    expect(btc[0]!.exchangeTs).toBe(wsFx['tickers.BTCUSDT:snapshot']![0].ts);
    expect(btc[0]!.connection).toBe('bybit/linear#0');
    expect(btc[1]!.values.mark).toBeUndefined(); // delta without markPrice
    expect(rec.updates.some((u) => u.symbol === '1000PEPEUSDT')).toBe(false);
  });

  it('re-subscribes after the connection drops and data resumes', async () => {
    const { rec, subscribes } = await setup();
    connector!.setTracked(['BTCUSDT']);
    await connector!.start();
    await waitFor(() => rec.updates.length >= 5, 3_000, 'first updates');
    const before = rec.updates.length;
    ex!.ws.connections[0]!.terminate();
    await waitFor(() => subscribes.length === 2, 5_000, 'resubscribe');
    await waitFor(() => rec.updates.length >= before + 5, 3_000, 'updates after reconnect');
    expect(subscribes[1]).toEqual(['tickers.BTCUSDT']);
    expect(connector!.health().connections[0]!.reconnects).toBe(1);
  });

  it('subscribes and unsubscribes when the tracked set changes', async () => {
    const { subscribes } = await setup();
    const received: string[] = [];
    ex!.ws.wss.on('connection', (s) => s.on('message', (d) => received.push(d.toString())));
    connector!.setTracked(['BTCUSDT']);
    await connector!.start();
    await waitFor(() => subscribes.length === 1, 3_000, 'initial subscribe');
    connector!.setTracked(['ETHUSDT']);
    await waitFor(() => received.some((t) => t.includes('unsubscribe')), 3_000, 'unsubscribe');
    expect(subscribes[1]).toEqual(['tickers.ETHUSDT']);
    expect(received.find((t) => t.includes('unsubscribe'))).toBe(
      '{"op":"unsubscribe","args":["tickers.BTCUSDT"]}',
    );
    // same connection throughout: no reconnect needed to change topics
    expect(ex!.ws.connections).toHaveLength(1);
  });
});
