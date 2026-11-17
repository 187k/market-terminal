import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, waitFor } from '../test-support/servers.js';
import {
  collectingSink,
  loadFixture,
  startReplayExchange,
  type ReplayExchange,
} from '../test-support/replay.js';
import { BinanceConnector } from './index.js';
import {
  fundingIntervals,
  isCryptoUsdtPerp,
  maxLeverageBySymbol,
  parseBookTicker,
  parsePremiumIndex,
  parseStreamEvent,
  parseTicker24h,
  signQuery,
  toInstrument,
  type BinanceSymbol,
} from './parse.js';

// Fixtures recorded from the live API with tools/record.mjs (2026-11-16).
const exchangeInfo = loadFixture(import.meta.url, 'rest-exchange-info');
const premium = loadFixture(import.meta.url, 'rest-premium-index');
const fundingInfo = loadFixture(import.meta.url, 'rest-funding-info');
const ticker24 = loadFixture(import.meta.url, 'rest-ticker-24hr');
const bookTicker = loadFixture(import.meta.url, 'rest-book-ticker');
const openInterest = loadFixture(import.meta.url, 'rest-open-interest');
const wsPublic: Record<string, any[]> = loadFixture(import.meta.url, 'ws-0');
const wsMarket: Record<string, any[]> = loadFixture(import.meta.url, 'ws-1');

describe('Binance normalisation (recorded payloads)', () => {
  const symbols: BinanceSymbol[] = exchangeInfo.symbols;

  it('keeps crypto USDT perpetuals and drops TradFi contracts', () => {
    const kept = symbols.filter(isCryptoUsdtPerp).map((s) => s.symbol);
    expect(kept.sort()).toEqual(['1000PEPEUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(symbols.find((s) => s.contractType === 'TRADIFI_PERPETUAL')).toBeDefined();
    const btc = symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(isCryptoUsdtPerp({ ...btc, underlyingType: 'INDEX' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, status: 'SETTLING' })).toBe(false);
  });

  it('maps instruments; max leverage needs an API key', () => {
    const pepe = toInstrument(
      symbols.find((s) => s.symbol === '1000PEPEUSDT')!,
      undefined,
      false,
    );
    expect(pepe).toMatchObject({ asset: 'PEPE', multiplier: 1000, base: '1000PEPE', quote: 'USDT' });
    expect(pepe.maxLeverage).toMatchObject({ available: false, reason: 'requires_api_key' });
    const withKey = toInstrument(
      symbols.find((s) => s.symbol === 'BTCUSDT')!,
      125,
      true,
    );
    expect(withKey.tickSize).toBe(0.1);
    expect(withKey.maxLeverage).toMatchObject({ available: true, value: 125 });
  });

  it('maps REST snapshots', () => {
    const p = premium.find((r: any) => r.symbol === 'ETHUSDT');
    expect(parsePremiumIndex(p)).toEqual({
      mark: Number(p.markPrice),
      index: Number(p.indexPrice),
      fundingRate: Number(p.lastFundingRate),
      nextFundingTime: p.nextFundingTime,
    });
    const t = ticker24.find((r: any) => r.symbol === 'ETHUSDT');
    expect(parseTicker24h(t)).toEqual({ last: Number(t.lastPrice), turnover24h: Number(t.quoteVolume) });
    const b = bookTicker.find((r: any) => r.symbol === 'BTCUSDT');
    expect(parseBookTicker(b)).toEqual({
      bid: Number(b.bidPrice),
      bidSize: Number(b.bidQty),
      ask: Number(b.askPrice),
      askSize: Number(b.askQty),
    });
  });

  it('reads funding intervals only for listed symbols', () => {
    const map = fundingIntervals(fundingInfo);
    expect(map.get(fundingInfo[0].symbol)).toBe(fundingInfo[0].fundingIntervalHours);
    expect(map.has('BTCUSDT')).toBe(false); // default 8 h applies
  });

  it('maps stream events: top-5 depth, mark price, 24 h ticker', () => {
    const depth = wsPublic['depth5@500ms']![0].data;
    expect(parseStreamEvent(depth)).toEqual({
      symbol: depth.s,
      ts: depth.E,
      values: {
        bid: Number(depth.b[0][0]),
        bidSize: Number(depth.b[0][1]),
        ask: Number(depth.a[0][0]),
        askSize: Number(depth.a[0][1]),
      },
    });
    const mark = wsMarket['markPrice@1s']![0].data;
    expect(parseStreamEvent(mark)?.values).toEqual({
      mark: Number(mark.p),
      index: Number(mark.i),
      fundingRate: Number(mark.r),
      nextFundingTime: mark.T,
    });
    const tick = wsMarket.ticker![0].data;
    expect(parseStreamEvent(tick)?.values).toEqual({ last: Number(tick.c), turnover24h: Number(tick.q) });
    expect(parseStreamEvent({ e: 'aggTrade', s: 'BTCUSDT' })).toBeNull();
  });

  it('takes the highest initial leverage from leverage brackets', () => {
    const map = maxLeverageBySymbol([
      { symbol: 'BTCUSDT', brackets: [{ initialLeverage: 125 }, { initialLeverage: 100 }] },
      { symbol: 'XUSDT', brackets: [] },
    ]);
    expect(map.get('BTCUSDT')).toBe(125);
    expect(map.has('XUSDT')).toBe(false);
  });

  it('signs queries with HMAC-SHA256 (example from the Binance API docs)', () => {
    const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
    const query =
      'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
    expect(signQuery(query, secret)).toBe('c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
  });
});

describe('BinanceConnector against a local replay of recorded traffic', () => {
  let ex: ReplayExchange | null = null;
  let connector: BinanceConnector | null = null;
  afterEach(async () => {
    await connector?.stop();
    await ex?.close();
    connector = null;
    ex = null;
  });

  async function setup() {
    const subscribes: string[][] = [];
    ex = await startReplayExchange({
      rest: {
        '/fapi/v1/exchangeInfo': exchangeInfo,
        '/fapi/v1/premiumIndex': premium,
        '/fapi/v1/ticker/24hr': ticker24,
        '/fapi/v1/ticker/bookTicker': bookTicker,
        '/fapi/v1/fundingInfo': fundingInfo,
        '/fapi/v1/openInterest': (q: URLSearchParams) => ({ ...openInterest, symbol: q.get('symbol') }),
      },
      onMessage: (text, send) => {
        const msg = JSON.parse(text);
        if (msg.method !== 'SUBSCRIBE') return;
        subscribes.push(msg.params);
        send({ result: null, id: msg.id });
        for (const stream of msg.params as string[]) {
          const [sym, ...rest] = stream.split('@');
          const kind = rest.join('@');
          const source = kind.startsWith('depth') ? wsPublic[kind] : wsMarket[kind];
          for (const m of source ?? []) if (m.data.s.toLowerCase() === sym) send(m);
        }
      },
    });
    const rec = collectingSink();
    connector = new BinanceConnector(
      { logger: silentLogger, sink: rec.sink },
      { restUrl: ex.restUrl, wsPublicUrl: ex.wsUrl, wsMarketUrl: ex.wsUrl },
    );
    return { rec, subscribes };
  }

  it('bootstraps from REST including the default funding interval', async () => {
    await setup();
    const boot = await connector!.loadMarkets();
    expect(boot.instruments.map((i) => i.symbol).sort()).toEqual(['1000PEPEUSDT', 'BTCUSDT', 'ETHUSDT']);
    const btc = boot.updates.filter((u) => u.symbol === 'BTCUSDT');
    const merged = Object.assign({}, ...btc.map((u) => u.values));
    expect(Object.keys(merged).sort()).toEqual(
      [
        'ask',
        'askSize',
        'bid',
        'bidSize',
        'fundingIntervalHours',
        'fundingRate',
        'index',
        'last',
        'mark',
        'nextFundingTime',
        'turnover24h',
      ].sort(),
    );
    expect(merged.fundingIntervalHours).toBe(8);
  });

  it('streams book, mark and ticker data and polls open interest', async () => {
    const { rec, subscribes } = await setup();
    connector!.setTracked(['BTCUSDT', 'ETHUSDT']);
    await connector!.start();
    await waitFor(() => subscribes.length === 2, 3_000, 'two connections subscribed');
    expect(subscribes.flat().sort()).toEqual(
      [
        'btcusdt@depth5@500ms',
        'ethusdt@depth5@500ms',
        'btcusdt@markPrice@1s',
        'btcusdt@ticker',
        'ethusdt@markPrice@1s',
        'ethusdt@ticker',
      ].sort(),
    );
    await waitFor(
      () =>
        ['bid', 'mark', 'last', 'openInterest'].every((f) =>
          rec.updates.some((u) => u.symbol === 'ETHUSDT' && f in u.values),
        ),
      3_000,
      'all field groups for ETH',
    );
    const oi = rec.updates.find((u) => u.values.openInterest !== undefined)!;
    expect(oi.values.openInterest).toBe(Number(openInterest.openInterest));
    expect(oi.connection).toBeNull();
    expect(new Set(rec.updates.filter((u) => u.connection).map((u) => u.connection))).toEqual(
      new Set(['binance/public#0', 'binance/market#0']),
    );
    expect(connector!.health().connections).toHaveLength(2);
  });
});
