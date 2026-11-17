import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConnectionStateEvent,
  ConnectorHealth,
  ExchangeCapabilities,
  ExchangeId,
  InstrumentInfo,
  MarketsBootstrap,
  MarketUpdate,
} from '@mip/core';
import type { ConnectorEvents, ExchangeConnector, MarketSink } from './base/connector.js';
import { ExchangeApiError } from './base/errors.js';
import { ConnectorSupervisor } from './supervisor.js';
import { silentLogger, waitFor } from './test-support/servers.js';

const NONE = { source: 'none' } as const;
const CAPS = Object.fromEntries(
  [
    'last',
    'mark',
    'index',
    'bid',
    'ask',
    'bidSize',
    'askSize',
    'openInterest',
    'fundingRate',
    'fundingIntervalHours',
    'nextFundingTime',
    'turnover24h',
  ].map((k) => [k, NONE]),
) as ExchangeCapabilities;

function instrument(exchange: ExchangeId, symbol: string): InstrumentInfo {
  return {
    exchange,
    symbol,
    base: symbol,
    asset: symbol,
    multiplier: 1,
    quote: 'USDT',
    contractSize: 1,
    tickSize: null,
    maxLeverage: { available: false, reason: 'not_provided' },
    indexKind: 'index',
    launchTime: null,
    url: '',
  };
}

class FakeConnector extends EventEmitter<ConnectorEvents> implements ExchangeConnector {
  readonly capabilities = CAPS;
  started = false;
  #tracked: string[] = [];
  constructor(
    readonly exchange: ExchangeId,
    private readonly fail: 'load' | 'start' | null = null,
  ) {
    super();
  }
  async loadMarkets(): Promise<MarketsBootstrap> {
    if (this.fail === 'load') throw new Error('exchange unreachable');
    return {
      instruments: [instrument(this.exchange, 'AAA'), instrument(this.exchange, 'BBB')],
      updates: [{ symbol: 'AAA', values: { last: 1 }, exchangeTs: null, receivedAt: 1, connection: null }],
    };
  }
  setTracked(symbols: readonly string[]) {
    this.#tracked = [...symbols];
  }
  tracked() {
    return this.#tracked;
  }
  async start() {
    if (this.fail === 'start') throw new Error('socket refused');
    this.started = true;
    this.emit('connection', {
      exchange: this.exchange,
      connection: 'main#0',
      state: 'open',
      reason: null,
      at: Date.now(),
    });
  }
  async stop() {
    this.started = false;
  }
  health(): ConnectorHealth {
    return {
      exchange: this.exchange,
      state: this.started ? 'ok' : 'stopped',
      detail: null,
      connections: [],
      rest: null,
      updatedAt: Date.now(),
    };
  }
}

function recordingSink() {
  const updates: [ExchangeId, MarketUpdate][] = [];
  const instruments: [ExchangeId, number][] = [];
  const sink: MarketSink = {
    market: (ex, u) => updates.push([ex, u]),
    instruments: (ex, list) => instruments.push([ex, list.length]),
  };
  return { sink, updates, instruments };
}

let supervisor: ConnectorSupervisor | null = null;
afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
});

describe('ConnectorSupervisor', () => {
  it('reports every exchange: running, not implemented, or disabled', async () => {
    supervisor = new ConnectorSupervisor({
      enabled: ['bybit', 'binance', 'gate'],
      factories: { bybit: () => new FakeConnector('bybit'), mexc: () => new FakeConnector('mexc') },
      logger: silentLogger,
      sink: recordingSink().sink,
    });
    await supervisor.start();
    const states = Object.fromEntries(supervisor.health().map((h) => [h.exchange, h.state]));
    expect(states).toEqual({
      bybit: 'ok',
      binance: 'not_implemented',
      mexc: 'disabled',
      hyperliquid: 'disabled',
      bitget: 'disabled',
      bingx: 'disabled',
      gate: 'not_implemented',
    });
  });

  it('loads markets, forwards them, asks which symbols to stream, then starts', async () => {
    const rec = recordingSink();
    const asked: string[] = [];
    supervisor = new ConnectorSupervisor({
      enabled: ['bybit'],
      factories: { bybit: () => new FakeConnector('bybit') },
      logger: silentLogger,
      sink: rec.sink,
      selectSymbols: async (exchange, boot) => {
        asked.push(`${exchange}:${boot.instruments.length}`);
        return ['AAA'];
      },
    });
    await supervisor.start();
    expect(asked).toEqual(['bybit:2']);
    expect(rec.instruments).toEqual([['bybit', 2]]);
    // only the REST snapshot rows of selected symbols are forwarded
    expect(rec.updates.map(([ex, u]) => `${ex}:${u.symbol}`)).toEqual(['bybit:AAA']);
    expect(supervisor.connector('bybit')?.tracked()).toEqual(['AAA']);

    supervisor.setTracked('bybit', ['AAA', 'BBB']);
    expect(supervisor.connector('bybit')?.tracked()).toEqual(['AAA', 'BBB']);
  });

  it('isolates a failing connector, reports it, and retries it', async () => {
    let attempts = 0;
    const events: ConnectionStateEvent[] = [];
    const failedLoads: string[] = [];
    supervisor = new ConnectorSupervisor({
      enabled: ['bybit', 'binance'],
      factories: {
        bybit: () => new FakeConnector('bybit'),
        binance: () => new FakeConnector('binance', ++attempts === 1 ? 'load' : null),
      },
      logger: silentLogger,
      sink: recordingSink().sink,
      restartDelayMs: 50,
      onLoadFailed: (ex) => failedLoads.push(ex),
    });
    supervisor.on('connection', (e) => events.push(e));
    await supervisor.start();

    const binance = () => supervisor!.health().find((h) => h.exchange === 'binance')!;
    expect(binance()).toMatchObject({ state: 'down' });
    expect(binance().detail).toMatch(
      /^load markets failed: exchange unreachable \(next attempt \d\d:\d\d:\d\d UTC\)$/,
    );
    expect(supervisor.health().find((h) => h.exchange === 'bybit')!.state).toBe('ok');
    expect(events).toContainEqual(expect.objectContaining({ exchange: 'binance', state: 'error' }));
    expect(failedLoads).toEqual(['binance']);

    await waitFor(() => binance().state === 'ok', 2_000, 'binance recovered');
    expect(attempts).toBe(2);
  });

  it('reports which step failed', async () => {
    supervisor = new ConnectorSupervisor({
      enabled: ['gate'],
      factories: { gate: () => new FakeConnector('gate', 'start') },
      logger: silentLogger,
      sink: recordingSink().sink,
      restartDelayMs: 60_000,
    });
    await supervisor.start();
    expect(supervisor.health().find((h) => h.exchange === 'gate')).toMatchObject({
      state: 'down',
      detail: expect.stringMatching(/^start failed: socket refused/),
    });
  });

  it('waits as long as the exchange asked after a ban before retrying', async () => {
    let attempts = 0;
    class BannedConnector extends FakeConnector {
      override async loadMarkets(): Promise<MarketsBootstrap> {
        attempts++;
        throw new ExchangeApiError('banned', 'HTTP 418: banned', { status: 418, retryAfterMs: 3_600_000 });
      }
    }
    supervisor = new ConnectorSupervisor({
      enabled: ['binance'],
      factories: { binance: () => new BannedConnector('binance') },
      logger: silentLogger,
      sink: recordingSink().sink,
      restartDelayMs: 10,
    });
    await supervisor.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBe(1); // not retried after 10 ms: the ban lasts an hour
    const detail = supervisor.health().find((h) => h.exchange === 'binance')!.detail!;
    const retryAt = new Date(Date.now() + 3_600_000).toISOString().slice(11, 16);
    expect(detail).toContain(`next attempt ${retryAt}`);
  });
});
