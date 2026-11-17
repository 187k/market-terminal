import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, waitFor } from '../test-support/servers.js';
import {
  collectingSink,
  loadFixture,
  startReplayExchange,
  type ReplayExchange,
} from '../test-support/replay.js';
import { BitgetConnector } from './index.js';
import { isCryptoUsdtPerp, parseFundRate, parseTicker, toInstrument, type BitgetContract } from './parse.js';

// Fixtures recorded from the live API with tools/record.mjs (2026-11-16).
const contracts = loadFixture(import.meta.url, 'rest-contracts');
const tickers = loadFixture(import.meta.url, 'rest-tickers');
const rates = loadFixture(import.meta.url, 'rest-current-fund-rate');
const wsFx: Record<string, any[]> = loadFixture(import.meta.url, 'ws-0');

const list: BitgetContract[] = contracts.data;

describe('Bitget normalisation (recorded payloads)', () => {
  it('keeps crypto perpetuals and drops RWA contracts', () => {
    const kept = list.filter(isCryptoUsdtPerp).map((c) => c.symbol);
    expect(kept).toEqual(expect.arrayContaining(['BTCUSDT', 'ETHUSDT']));
    const rwa = list.find((c) => c.isRwa === 'YES');
    expect(rwa).toBeDefined();
    expect(isCryptoUsdtPerp(rwa!)).toBe(false);
    expect(isCryptoUsdtPerp({ ...list[0]!, symbolStatus: 'maintain' })).toBe(false);
  });

  it('maps instruments; tick size from price places', () => {
    expect(toInstrument(list.find((c) => c.symbol === 'BTCUSDT')!)).toMatchObject({
      asset: 'BTC',
      multiplier: 1,
      tickSize: 0.1,
      contractSize: 1,
      url: 'https://www.bitget.com/futures/usdt/BTCUSDT',
    });
    expect(toInstrument(list.find((c) => c.symbol === 'ETHUSDT')!).maxLeverage).toMatchObject({
      available: true,
    });
  });

  it('maps REST tickers and funding settings', () => {
    const btc = tickers.data.find((t: any) => t.symbol === 'BTCUSDT');
    expect(parseTicker(btc)).toEqual({
      last: Number(btc.lastPr),
      mark: Number(btc.markPrice),
      index: Number(btc.indexPrice),
      bid: Number(btc.bidPr),
      ask: Number(btc.askPr),
      bidSize: Number(btc.bidSz),
      askSize: Number(btc.askSz),
      openInterest: Number(btc.holdingAmount),
      fundingRate: Number(btc.fundingRate),
      turnover24h: Number(btc.quoteVolume),
    });
    expect(parseFundRate(rates.data[0])).toEqual({
      fundingRate: Number(rates.data[0].fundingRate),
      fundingIntervalHours: 8,
      nextFundingTime: Number(rates.data[0].nextUpdate),
    });
  });

  it('maps WS ticker snapshots, including next funding time', () => {
    const d = wsFx['ticker:snapshot']![0].data[0];
    expect(parseTicker(d)).toMatchObject({
      last: Number(d.lastPr),
      nextFundingTime: Number(d.nextFundingTime),
    });
  });
});

describe('BitgetConnector against a local replay of recorded traffic', () => {
  let ex: ReplayExchange | null = null;
  let connector: BitgetConnector | null = null;
  afterEach(async () => {
    await connector?.stop();
    await ex?.close();
    connector = null;
    ex = null;
  });

  it('bootstraps, subscribes and answers pongs without errors', async () => {
    const subs: unknown[][] = [];
    ex = await startReplayExchange({
      rest: {
        '/api/v2/mix/market/contracts': contracts,
        '/api/v2/mix/market/tickers': tickers,
        '/api/v2/mix/market/current-fund-rate': rates,
      },
      onMessage: (text, send) => {
        if (text === 'ping') return send('pong');
        const msg = JSON.parse(text);
        if (msg.op !== 'subscribe') return;
        subs.push(msg.args);
        send('pong'); // non-JSON frames must be tolerated
        for (const m of wsFx['ticker:snapshot'] ?? []) send(m);
      },
    });
    const rec = collectingSink();
    connector = new BitgetConnector(
      { logger: silentLogger, sink: rec.sink },
      { restUrl: ex.restUrl, wsUrl: ex.wsUrl },
    );
    const boot = await connector.loadMarkets();
    const btc = Object.assign({}, ...boot.updates.filter((u) => u.symbol === 'BTCUSDT').map((u) => u.values));
    expect(btc.fundingIntervalHours).toBe(8);

    connector.setTracked(['BTCUSDT', 'ETHUSDT']);
    await connector.start();
    await waitFor(() => rec.updates.filter((u) => u.connection).length >= 2, 3_000, 'ticker pushes');
    expect(subs[0]).toEqual([
      { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
      { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'ETHUSDT' },
    ]);
    expect(connector.health().detail).toBeNull();
  });
});
