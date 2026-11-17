import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, waitFor } from '../test-support/servers.js';
import {
  collectingSink,
  loadFixture,
  startReplayExchange,
  type ReplayExchange,
} from '../test-support/replay.js';
import { BingxConnector } from './index.js';
import {
  isCryptoUsdtPerp,
  openInterestToBase,
  parsePremiumIndex,
  parseStreamEvent,
  parseTicker,
  toInstrument,
  type BingxContract,
} from './parse.js';

// Fixtures recorded from the live API with tools/record.mjs (2026-11-16).
const contracts = loadFixture(import.meta.url, 'rest-contracts');
const premium = loadFixture(import.meta.url, 'rest-premium-index');
const tickers = loadFixture(import.meta.url, 'rest-ticker');
const oi = loadFixture(import.meta.url, 'rest-open-interest');
const wsFx: Record<string, any[]> = loadFixture(import.meta.url, 'ws-0');

const list: BingxContract[] = contracts.data;

describe('BingX normalisation (recorded payloads)', () => {
  it('maps contracts; max leverage is not public', () => {
    const pepe = toInstrument(list.find((c) => c.symbol === '1000PEPE-USDT')!);
    expect(pepe).toMatchObject({ base: '1000PEPE', asset: 'PEPE', multiplier: 1000, quote: 'USDT' });
    expect(pepe.maxLeverage).toMatchObject({ available: false, reason: 'not_provided' });
    expect(toInstrument(list.find((c) => c.symbol === 'BTC-USDT')!).tickSize).toBeCloseTo(0.1, 12);
  });

  it('drops suspended and non-crypto (NC…) contracts', () => {
    const btc = list.find((c) => c.symbol === 'BTC-USDT')!;
    expect(isCryptoUsdtPerp(btc)).toBe(true);
    expect(isCryptoUsdtPerp({ ...btc, status: 25 })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, symbol: 'NCFXEUR2USD-USDT' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, symbol: 'NCSKAAPL2USD-USDT' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, symbol: 'NCCOXAU2USD-USDT' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, symbol: 'NCSISPX2USD-USDT' })).toBe(false);
  });

  it('maps REST premium index and ticker', () => {
    const p = premium.data[0];
    expect(parsePremiumIndex(p)).toEqual({
      mark: Number(p.markPrice),
      index: Number(p.indexPrice),
      fundingRate: Number(p.lastFundingRate),
      fundingIntervalHours: 8,
      nextFundingTime: p.nextFundingTime,
    });
    const t = tickers.data[0];
    expect(parseTicker(t)).toEqual({
      last: Number(t.lastPrice),
      bid: Number(t.bidPrice),
      bidSize: Number(t.bidQty),
      ask: Number(t.askPrice),
      askSize: Number(t.askQty),
      turnover24h: Number(t.quoteVolume),
    });
  });

  it('maps WS book ticker, mark price and 24 h ticker', () => {
    const b = wsFx.bookTicker![0].data;
    expect(parseStreamEvent(b)).toEqual({
      symbol: 'BTC-USDT',
      ts: b.E,
      values: { bid: Number(b.b), bidSize: Number(b.B), ask: Number(b.a), askSize: Number(b.A) },
    });
    expect(parseStreamEvent(wsFx.markPrice![0].data)?.values).toEqual({
      mark: Number(wsFx.markPrice![0].data.p),
    });
    const t = wsFx.ticker![0].data;
    expect(parseStreamEvent(t)?.values).toEqual({ last: Number(t.c), turnover24h: Number(t.q) });
  });

  it('converts open interest from USDT notional with the mark price', () => {
    const notional = Number(oi.data.openInterest);
    const mark = Number(premium.data.find((p: any) => p.symbol === 'BTC-USDT').markPrice);
    // ~10.7k BTC: same order as other venues; reading the value as coins (6.9e8 BTC) is impossible
    expect(openInterestToBase(notional, mark)).toBeCloseTo(notional / mark, 9);
    expect(openInterestToBase(notional, mark)!).toBeGreaterThan(1_000);
    expect(openInterestToBase(notional, mark)!).toBeLessThan(100_000);
    expect(openInterestToBase(1, 0)).toBeUndefined();
  });
});

describe('BingxConnector against a local replay of recorded traffic', () => {
  let ex: ReplayExchange | null = null;
  let connector: BingxConnector | null = null;
  afterEach(async () => {
    await connector?.stop();
    await ex?.close();
    connector = null;
    ex = null;
  });

  it('decodes GZIP frames, answers Ping and polls REST-only fields', async () => {
    const subs: string[] = [];
    let pongs = 0;
    ex = await startReplayExchange({
      rest: {
        '/openApi/swap/v2/quote/contracts': contracts,
        '/openApi/swap/v2/quote/premiumIndex': premium,
        '/openApi/swap/v2/quote/ticker': tickers,
        '/openApi/swap/v2/quote/openInterest': (q: URLSearchParams) => ({
          ...oi,
          data: { ...oi.data, symbol: q.get('symbol') },
        }),
      },
      onMessage: () => undefined,
    });
    // BingX sends every frame as binary GZIP, so answer on the raw socket.
    ex.ws.wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const text = data.toString();
        if (text === 'Pong') return void pongs++;
        const msg = JSON.parse(text);
        if (msg.reqType !== 'sub') return;
        subs.push(msg.dataType);
        if (subs.length === 1) socket.send(gzipSync('Ping'));
        const kind = msg.dataType.split('@')[1];
        for (const m of wsFx[kind] ?? [])
          if (m.dataType === msg.dataType) socket.send(gzipSync(JSON.stringify(m)));
      });
    });

    const rec = collectingSink();
    connector = new BingxConnector(
      { logger: silentLogger, sink: rec.sink },
      { restUrl: ex.restUrl, wsUrl: ex.wsUrl },
    );
    await connector.loadMarkets();
    connector.setTracked(['BTC-USDT']);
    await connector.start();
    await waitFor(() => subs.length === 3, 3_000, 'three topics');
    expect(subs.sort()).toEqual(['BTC-USDT@bookTicker', 'BTC-USDT@markPrice', 'BTC-USDT@ticker']);
    await waitFor(() => pongs === 1, 3_000, 'Pong reply');
    await waitFor(
      () =>
        ['bid', 'mark', 'last', 'index', 'openInterest'].every((f) => rec.updates.some((u) => f in u.values)),
      3_000,
      'all field groups',
    );
    const oiUpdate = rec.updates.find((u) => u.values.openInterest !== undefined)!;
    expect(oiUpdate.values.openInterest).toBeGreaterThan(1_000);
  });
});
