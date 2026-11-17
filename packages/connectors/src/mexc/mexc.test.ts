import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, waitFor } from '../test-support/servers.js';
import {
  collectingSink,
  loadFixture,
  startReplayExchange,
  type ReplayExchange,
} from '../test-support/replay.js';
import { MexcConnector } from './index.js';
import { isCryptoUsdtPerp, parseFundingRate, parseTicker, toInstrument, type MexcContract } from './parse.js';

// Fixtures recorded from the live API with tools/record.mjs (2026-11-17; REST via the documented
// api.mexc.com, WS via the contract.mexc.co mirror because this network is refused by contract.mexc.com).
const detail = loadFixture(import.meta.url, 'rest-detail');
const tickers = loadFixture(import.meta.url, 'rest-ticker');
const funding = loadFixture(import.meta.url, 'rest-funding-rate');
const wsFx: Record<string, any[]> = loadFixture(import.meta.url, 'ws-0');

const contract = (s: string): MexcContract => detail.data.find((c: MexcContract) => c.symbol === s);

describe('MEXC normalisation (recorded payloads)', () => {
  it('maps contracts; sizes are contracts x contractSize', () => {
    expect(toInstrument(contract('BTC_USDT'))).toMatchObject({
      symbol: 'BTC_USDT',
      asset: 'BTC',
      contractSize: 0.0001,
    });
    expect(toInstrument(contract('PEPE_USDT'))).toMatchObject({
      asset: 'PEPE',
      multiplier: 1,
      contractSize: 10_000_000,
    });
    expect(toInstrument(contract('BTC_USDT')).maxLeverage).toMatchObject({ available: true });
    const btc = contract('BTC_USDT');
    expect(isCryptoUsdtPerp(btc)).toBe(true);
    expect(isCryptoUsdtPerp({ ...btc, state: 1 })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, futureType: 2 })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, isHidden: true })).toBe(false);
  });

  it('maps the ticker: fairPrice is the mark, holdVol is open interest in contracts', () => {
    const t = tickers.data.find((x: any) => x.symbol === 'ETH_USDT');
    expect(parseTicker(t, 0.01)).toEqual({
      last: t.lastPrice,
      mark: t.fairPrice,
      index: t.indexPrice,
      bid: t.bid1,
      ask: t.ask1,
      fundingRate: t.fundingRate,
      turnover24h: t.amount24,
      openInterest: t.holdVol * 0.01,
    });
  });

  it('maps funding settings (collectCycle in hours)', () => {
    const r = funding.data.find((x: any) => x.symbol === 'BTC_USDT');
    expect(parseFundingRate(r)).toEqual({
      fundingRate: r.fundingRate,
      fundingIntervalHours: r.collectCycle,
      nextFundingTime: r.nextSettleTime,
    });
  });

  it('maps a WS push.ticker the same way as the REST ticker', () => {
    const push = wsFx['push.ticker']![0];
    const v = parseTicker(push.data, 0.01);
    expect(v).toMatchObject({
      last: push.data.lastPrice,
      bid: push.data.bid1,
      ask: push.data.ask1,
      openInterest: push.data.holdVol * 0.01,
    });
  });
});

describe('MexcConnector against a local replay of recorded traffic', () => {
  let ex: ReplayExchange | null = null;
  let connector: MexcConnector | null = null;
  afterEach(async () => {
    await connector?.stop();
    await ex?.close();
    connector = null;
    ex = null;
  });

  async function setup(fundingBody: unknown) {
    const subs: string[] = [];
    ex = await startReplayExchange({
      rest: {
        '/api/v1/contract/detail': detail,
        '/api/v1/contract/ticker': tickers,
        '/api/v1/contract/funding_rate': fundingBody,
        '/api/v1/contract/funding_rate/BTC_USDT': {
          ...funding,
          data: funding.data.find((x: any) => x.symbol === 'BTC_USDT'),
        },
      },
      onMessage: (text, send) => {
        const msg = JSON.parse(text);
        if (msg.method === 'ping') return send({ channel: 'pong', data: Date.now() });
        if (msg.method !== 'sub.ticker') return;
        subs.push(msg.param.symbol);
        send({ channel: 'rs.sub.ticker', data: 'success' });
        for (const m of wsFx['push.ticker'] ?? []) if (m.symbol === msg.param.symbol) send(m);
      },
    });
    const rec = collectingSink();
    connector = new MexcConnector(
      { logger: silentLogger, sink: rec.sink },
      { restUrl: ex.restUrl, wsUrl: ex.wsUrl },
    );
    return { rec, subs };
  }

  it('bootstraps from REST and streams sub.ticker', async () => {
    const { rec, subs } = await setup(funding);
    const boot = await connector!.loadMarkets();
    expect(boot.instruments.map((i) => i.symbol).sort()).toEqual(['BTC_USDT', 'ETH_USDT', 'PEPE_USDT']);
    const btc = Object.assign(
      {},
      ...boot.updates.filter((u) => u.symbol === 'BTC_USDT').map((u) => u.values),
    );
    expect(btc).toMatchObject({ fundingIntervalHours: 8 });

    const symbols = [...new Set((wsFx['push.ticker'] ?? []).map((m) => m.symbol as string))];
    connector!.setTracked(symbols);
    await connector!.start();
    await waitFor(() => rec.updates.some((u) => u.connection === 'mexc/contract#0'), 3_000, 'push.ticker');
    expect(subs.sort()).toEqual(symbols.sort());
    expect(connector!.health().detail).toBeNull();
  });

  it('falls back to per-symbol funding requests if the bulk form returns one object', async () => {
    await setup({ ...funding, data: funding.data[0] });
    connector!.setTracked(['BTC_USDT']);
    const boot = await connector!.loadMarkets();
    expect(boot.updates.some((u) => u.symbol === 'BTC_USDT' && u.values.fundingIntervalHours === 8)).toBe(
      true,
    );
    expect(ex!.http.hits.some((h) => h.path === '/api/v1/contract/funding_rate/BTC_USDT')).toBe(true);
  });
});
