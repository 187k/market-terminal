import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, waitFor } from '../test-support/servers.js';
import {
  collectingSink,
  loadFixture,
  startReplayExchange,
  type ReplayExchange,
} from '../test-support/replay.js';
import { GateConnector } from './index.js';
import {
  isCryptoUsdtPerp,
  parseBookTicker,
  parseContractFunding,
  parseTicker,
  toInstrument,
  type GateContract,
} from './parse.js';

// Fixtures recorded from the live API with tools/record.mjs (2026-11-16).
const contracts: GateContract[] = loadFixture(import.meta.url, 'rest-contracts');
const tickers: Record<string, unknown>[] = loadFixture(import.meta.url, 'rest-tickers');
const wsFx: Record<string, any[]> = loadFixture(import.meta.url, 'ws-0');

const byName = (n: string) => contracts.find((c) => c.name === n)!;

describe('Gate normalisation (recorded payloads)', () => {
  it('maps contracts; contract size is quanto_multiplier', () => {
    const pepe = toInstrument(byName('PEPE_USDT'));
    expect(pepe).toMatchObject({
      symbol: 'PEPE_USDT',
      base: 'PEPE',
      asset: 'PEPE',
      multiplier: 1,
      quote: 'USDT',
    });
    expect(pepe.contractSize).toBe(Number(byName('PEPE_USDT').quanto_multiplier));
    expect(toInstrument(byName('BTC_USDT'))).toMatchObject({
      contractSize: 0.0001,
      tickSize: 0.1,
      launchTime: 1574035200000,
    });
    expect(toInstrument(byName('BTC_USDT')).maxLeverage).toMatchObject({ available: true, value: 200 });
  });

  it('keeps tradable crypto perpetuals only', () => {
    const btc = byName('BTC_USDT');
    expect(isCryptoUsdtPerp(btc)).toBe(true);
    expect(isCryptoUsdtPerp({ ...btc, in_delisting: true })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, status: 'delisting' })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, is_pre_market: true })).toBe(false);
    expect(isCryptoUsdtPerp({ ...btc, contract_type: 'stocks' })).toBe(false);
  });

  it('converts sizes from contracts and halves the two-sided total_size', () => {
    const eth = tickers.find((t) => t.contract === 'ETH_USDT')!;
    const contract = byName('ETH_USDT') as GateContract & { position_size: number };
    const v = parseTicker(eth, 0.01);
    expect(v.openInterest).toBeCloseTo((Number(eth.total_size) / 2) * 0.01, 6);
    // total_size is twice the one-sided position_size (the two calls were ~0.4 s apart)
    expect(Number(eth.total_size) / (2 * contract.position_size)).toBeCloseTo(1, 3);
    expect(v).toMatchObject({
      last: Number(eth.last),
      mark: Number(eth.mark_price),
      index: Number(eth.index_price),
      bid: Number(eth.highest_bid),
      ask: Number(eth.lowest_ask),
      fundingRate: Number(eth.funding_rate),
      turnover24h: Number(eth.volume_24h_quote),
    });
    expect(v.bidSize).toBeCloseTo(Number(eth.highest_size) * 0.01, 9);
  });

  it('reads the funding interval (seconds) and next settlement from contracts', () => {
    expect(parseContractFunding(byName('BTC_USDT'))).toEqual({
      fundingIntervalHours: 8,
      nextFundingTime: 1794816000000,
    });
  });

  it('maps WS tickers and book tickers', () => {
    const tick = wsFx['futures.tickers:update']![0].result[0];
    expect(parseTicker(tick, 1)).toMatchObject({
      fundingIntervalHours: 8,
      nextFundingTime: tick.funding_next_apply * 1000,
    });
    const book = wsFx['futures.book_ticker:update']![1].result;
    expect(parseBookTicker(book, 0.01)).toEqual({
      bid: Number(book.b),
      ask: Number(book.a),
      bidSize: book.B * 0.01,
      askSize: book.A * 0.01,
    });
  });
});

describe('GateConnector against a local replay of recorded traffic', () => {
  let ex: ReplayExchange | null = null;
  let connector: GateConnector | null = null;
  afterEach(async () => {
    await connector?.stop();
    await ex?.close();
    connector = null;
    ex = null;
  });

  it('bootstraps, subscribes both channels and normalises pushes', async () => {
    const subs: { channel: string; payload: string[] }[] = [];
    ex = await startReplayExchange({
      rest: { '/api/v4/futures/usdt/contracts': contracts, '/api/v4/futures/usdt/tickers': tickers },
      onMessage: (text, send) => {
        const msg = JSON.parse(text);
        if (msg.event !== 'subscribe') return;
        subs.push({ channel: msg.channel, payload: msg.payload });
        const kind = `${msg.channel}:update`;
        for (const m of wsFx[kind] ?? []) send(m);
      },
    });
    const rec = collectingSink();
    connector = new GateConnector(
      { logger: silentLogger, sink: rec.sink },
      { restUrl: ex.restUrl, wsUrl: ex.wsUrl },
    );
    const boot = await connector.loadMarkets();
    expect(boot.instruments.map((i) => i.symbol)).toEqual(
      expect.arrayContaining(['BTC_USDT', 'ETH_USDT', 'PEPE_USDT']),
    );
    expect(ex.http.hits[0]!.headers['x-gate-size-decimal']).toBe('1');

    connector.setTracked(['ETH_USDT', 'PEPE_USDT']);
    await connector.start();
    await waitFor(() => subs.length === 2, 3_000, 'two channel subscriptions');
    expect(subs.map((s) => s.channel).sort()).toEqual(['futures.book_ticker', 'futures.tickers']);
    expect(subs[0]!.payload).toEqual(['ETH_USDT', 'PEPE_USDT']);
    await waitFor(
      () => rec.updates.some((u) => u.connection && u.values.bid !== undefined),
      3_000,
      'book update',
    );
    const book = rec.updates.find(
      (u) => u.connection && u.symbol === 'ETH_USDT' && u.values.bidSize !== undefined,
    )!;
    expect(book.values.bidSize).toBeCloseTo(2457 * 0.01, 9);
  });
});
