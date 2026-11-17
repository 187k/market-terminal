import type { ExchangeCapabilities, MarketsBootstrap, MarketUpdate } from '@mip/core';
import { BaseConnector, type ConnectorContext } from '../base/connector.js';
import { sharedRateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { batchMessages, SubscriptionManager, type SubscriptionProtocol } from '../base/subscriptions.js';
import type { WsMessage } from '../base/ws-client.js';
import {
  isCryptoUsdtPerp,
  parseBookTicker,
  parseContractFunding,
  parseTicker,
  parseTrades,
  toInstrument,
  type GateContract,
} from './parse.js';

const REST_URL = 'https://api.gateio.ws';
const WS_URL = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
/** Without this header, sizes of contracts with `enable_decimal` are rounded down to integers (Gate docs). */
const DECIMAL_HEADER = { 'X-Gate-Size-Decimal': '1' };

const CHANNELS = ['futures.tickers', 'futures.book_ticker', 'futures.trades'] as const;
const WS_CHANGE = { source: 'ws', refresh: 'change', maxAgeMs: 300_000 } as const;

export const GATE_CAPABILITIES: ExchangeCapabilities = {
  last: WS_CHANGE,
  mark: WS_CHANGE,
  index: WS_CHANGE,
  bid: WS_CHANGE,
  ask: WS_CHANGE,
  bidSize: { ...WS_CHANGE, note: 'contracts × quanto_multiplier' },
  askSize: { ...WS_CHANGE, note: 'contracts × quanto_multiplier' },
  openInterest: { ...WS_CHANGE, note: 'total_size / 2 × quanto_multiplier (total_size counts both sides)' },
  fundingRate: WS_CHANGE,
  fundingIntervalHours: WS_CHANGE,
  nextFundingTime: WS_CHANGE,
  turnover24h: WS_CHANGE,
};

/**
 * Gate API v4, USDT-settled perpetuals. Sizes are in contracts everywhere and are converted
 * with `quanto_multiplier`. Public REST: 200 requests / 10 s per endpoint.
 */
export class GateConnector extends BaseConnector {
  readonly exchange = 'gate' as const;
  readonly capabilities = GATE_CAPABILITIES;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  #stream: SubscriptionManager | null = null;
  /** Contract size (quanto multiplier) per symbol, for converting WS sizes. */
  #sizes = new Map<string, number>();

  constructor(ctx: ConnectorContext, endpoints: { restUrl?: string; wsUrl?: string } = {}) {
    super(ctx, 'gate');
    this.#wsUrl = endpoints.wsUrl ?? WS_URL;
    this.#rest = this.registerRest(
      new RestClient({
        exchange: 'gate',
        baseUrl: endpoints.restUrl ?? REST_URL,
        limiter: sharedRateLimiter({ name: 'gate/rest', windows: [{ limit: 200, windowMs: 10_000 }] }),
        logger: this.log,
        headers: DECIMAL_HEADER,
      }),
    );
  }

  async loadMarkets(): Promise<MarketsBootstrap> {
    const [contracts, tickers] = await Promise.all([
      this.#rest.get<GateContract[]>('/api/v4/futures/usdt/contracts'),
      this.#rest.get<Record<string, unknown>[]>('/api/v4/futures/usdt/tickers'),
    ]);
    const tradable = contracts.filter(isCryptoUsdtPerp);
    const instruments = tradable.map(toInstrument);
    this.#sizes = new Map(instruments.map((i) => [i.symbol, i.contractSize]));
    const receivedAt = Date.now();
    const updates: MarketUpdate[] = [];
    for (const c of tradable) {
      updates.push({
        symbol: c.name,
        values: parseContractFunding(c),
        exchangeTs: null,
        receivedAt,
        connection: null,
      });
    }
    for (const t of tickers) {
      const symbol = String(t.contract);
      const size = this.#sizes.get(symbol);
      if (size === undefined) continue;
      updates.push({ symbol, values: parseTicker(t, size), exchangeTs: null, receivedAt, connection: null });
    }
    return { instruments, updates };
  }

  protected async onStart(): Promise<void> {
    const stream = new SubscriptionManager({
      name: 'gate/usdt',
      url: this.#wsUrl,
      maxTopicsPerConnection: 200,
      maxConnections: 10,
      logger: this.log,
      protocol: this.#protocol(),
      sendRate: { limit: 10, windowMs: 1_000 },
      socket: {
        headers: DECIMAL_HEADER,
        heartbeat: {
          intervalMs: 15_000,
          message: () => JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' }),
        },
      },
    });
    stream.on('message', (m) => this.#onMessage(m));
    this.#stream = this.registerStream(stream);
    stream.add(this.#topics(this.tracked()));
    stream.start();
  }

  protected onTrackedChanged(added: string[], removed: string[]): void {
    this.#stream?.add(this.#topics(added));
    this.#stream?.remove(this.#topics(removed));
  }

  #topics(symbols: string[]): string[] {
    const channels = CHANNELS.filter((c) => c !== 'futures.trades' || this.wantsTrades);
    return symbols.flatMap((s) => channels.map((c) => `${c}|${s}`));
  }

  #protocol(): SubscriptionProtocol {
    const encode = (event: 'subscribe' | 'unsubscribe') => (topics: readonly string[]) => {
      const out: string[] = [];
      for (const channel of CHANNELS) {
        const symbols = topics
          .filter((t) => t.startsWith(`${channel}|`))
          .map((t) => t.slice(channel.length + 1));
        out.push(
          ...batchMessages(symbols, { maxItems: 50 }, (payload) =>
            JSON.stringify({ time: Math.floor(Date.now() / 1000), channel, event, payload }),
          ),
        );
      }
      return out;
    };
    return { subscribe: encode('subscribe'), unsubscribe: encode('unsubscribe') };
  }

  #onMessage(m: WsMessage): void {
    let msg: {
      channel?: string;
      event?: string;
      result?: unknown;
      error?: { message?: string } | null;
      time_ms?: number;
    };
    try {
      msg = JSON.parse(m.text);
    } catch {
      this.log.warn({ connection: m.connection }, 'non-JSON message');
      return;
    }
    if (msg.event === 'update' && msg.channel === 'futures.tickers' && Array.isArray(msg.result)) {
      for (const t of msg.result as Record<string, unknown>[]) {
        const symbol = String(t.contract);
        const size = this.#sizes.get(symbol);
        if (size === undefined) continue;
        this.push({
          symbol,
          values: parseTicker(t, size),
          exchangeTs: num(t.t) ?? msg.time_ms ?? null,
          receivedAt: m.receivedAt,
          connection: m.connection,
        });
      }
      return;
    }
    if (
      msg.event === 'update' &&
      msg.channel === 'futures.book_ticker' &&
      msg.result &&
      typeof msg.result === 'object'
    ) {
      const r = msg.result as Record<string, unknown>;
      const symbol = String(r.s);
      const size = this.#sizes.get(symbol);
      if (size === undefined) return;
      this.push({
        symbol,
        values: parseBookTicker(r, size),
        exchangeTs: num(r.t) ?? null,
        receivedAt: m.receivedAt,
        connection: m.connection,
      });
      return;
    }
    if (msg.event === 'update' && msg.channel === 'futures.trades') {
      for (const t of parseTrades(msg.result, (s) => this.#sizes.get(s))) this.pushTrade(t);
      return;
    }
    if (msg.event === 'subscribe' && msg.error) {
      this.log.warn({ channel: msg.channel, error: msg.error }, 'subscription rejected');
      this.setDetail(`subscription rejected: ${msg.error.message ?? 'unknown'}`);
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
