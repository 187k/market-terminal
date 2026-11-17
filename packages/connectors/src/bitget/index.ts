import type { ExchangeCapabilities, MarketsBootstrap, MarketUpdate } from '@mip/core';
import { BaseConnector, type ConnectorContext } from '../base/connector.js';
import { sharedRateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { batchMessages, SubscriptionManager } from '../base/subscriptions.js';
import type { WsMessage } from '../base/ws-client.js';
import {
  isCryptoUsdtPerp,
  parseFundRate,
  parseTicker,
  parseTrades,
  toInstrument,
  type BitgetContract,
} from './parse.js';

const REST_URL = 'https://api.bitget.com';
const WS_URL = 'wss://ws.bitget.com/v2/ws/public';
const PRODUCT = 'USDT-FUTURES';

const WS_CHANGE = { source: 'ws', refresh: 'change', maxAgeMs: 300_000 } as const;

export const BITGET_CAPABILITIES: ExchangeCapabilities = {
  last: WS_CHANGE,
  mark: WS_CHANGE,
  index: WS_CHANGE,
  bid: WS_CHANGE,
  ask: WS_CHANGE,
  bidSize: WS_CHANGE,
  askSize: WS_CHANGE,
  openInterest: { ...WS_CHANGE, note: 'holdingAmount, base coin' },
  fundingRate: WS_CHANGE,
  fundingIntervalHours: {
    source: 'rest',
    refresh: 'interval',
    maxAgeMs: 60 * 60_000,
    note: 'current-fund-rate, refreshed every 15 min (not in the ticker stream)',
  },
  nextFundingTime: WS_CHANGE,
  turnover24h: WS_CHANGE,
};

interface BitgetResponse<T> {
  code: string;
  msg: string;
  requestTime: number;
  data: T;
}

/**
 * Bitget Classic V2 (USDT-M futures). The Classic API is in maintenance mode but works; the
 * ticker channel carries every field except the funding interval.
 * Limits: < 50 channels per connection recommended, 240 subscribe requests / hour per
 * connection, subscribe payload <= 4,096 bytes, ping every 30 s (dropped after 2 min).
 */
export class BitgetConnector extends BaseConnector {
  readonly exchange = 'bitget' as const;
  readonly capabilities = BITGET_CAPABILITIES;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  #stream: SubscriptionManager | null = null;

  constructor(ctx: ConnectorContext, endpoints: { restUrl?: string; wsUrl?: string } = {}) {
    super(ctx, 'bitget');
    this.#wsUrl = endpoints.wsUrl ?? WS_URL;
    this.#rest = this.registerRest(
      new RestClient({
        exchange: 'bitget',
        baseUrl: endpoints.restUrl ?? REST_URL,
        limiter: sharedRateLimiter({ name: 'bitget/rest', windows: [{ limit: 20, windowMs: 1_000 }] }),
        logger: this.log,
        checkBody: (body) => {
          const b = body as Partial<BitgetResponse<unknown>> | null;
          if (!b || b.code === undefined || b.code === '00000') return null;
          return {
            code: b.code,
            message: b.msg ?? '',
            ...(b.code === '429' ? { kind: 'rate_limited' } : {}),
          };
        },
      }),
    );
  }

  async loadMarkets(): Promise<MarketsBootstrap> {
    const [contracts, tickers, rates] = await Promise.all([
      this.#rest.get<BitgetResponse<BitgetContract[]>>('/api/v2/mix/market/contracts', {
        productType: PRODUCT,
      }),
      this.#rest.get<BitgetResponse<Record<string, unknown>[]>>('/api/v2/mix/market/tickers', {
        productType: PRODUCT,
      }),
      this.#rest.get<BitgetResponse<Record<string, unknown>[]>>('/api/v2/mix/market/current-fund-rate', {
        productType: PRODUCT,
      }),
    ]);
    const instruments = contracts.data.filter(isCryptoUsdtPerp).map(toInstrument);
    const listed = new Set(instruments.map((i) => i.symbol));
    const receivedAt = Date.now();
    const updates: MarketUpdate[] = [];
    for (const t of tickers.data) {
      const symbol = String(t.symbol);
      if (listed.has(symbol))
        updates.push({
          symbol,
          values: parseTicker(t),
          exchangeTs: Number(t.ts) || null,
          receivedAt,
          connection: null,
        });
    }
    for (const r of rates.data) {
      const symbol = String(r.symbol);
      if (listed.has(symbol))
        updates.push({
          symbol,
          values: parseFundRate(r),
          exchangeTs: rates.requestTime ?? null,
          receivedAt,
          connection: null,
        });
    }
    return { instruments, updates };
  }

  protected async onStart(): Promise<void> {
    // Topics are "ticker|SYMBOL" or "trade|SYMBOL".
    const arg = (topic: string) => {
      const [channel, instId] = topic.split('|');
      return { instType: PRODUCT, channel, instId };
    };
    const encode = (op: string) => (topics: readonly string[]) =>
      batchMessages(topics, { maxItems: 50, maxBytes: 4_000 }, (ids) =>
        JSON.stringify({ op, args: ids.map(arg) }),
      );
    const stream = new SubscriptionManager({
      name: 'bitget/public',
      url: this.#wsUrl,
      // Bitget recommends fewer than 50 channels per connection.
      maxTopicsPerConnection: 45,
      maxConnections: 20,
      logger: this.log,
      protocol: { subscribe: encode('subscribe'), unsubscribe: encode('unsubscribe') },
      sendRate: { limit: 5, windowMs: 1_000 },
      socket: { heartbeat: { intervalMs: 25_000, message: () => 'ping' } },
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
    return symbols.flatMap((s) => (this.wantsTrades ? [`ticker|${s}`, `trade|${s}`] : [`ticker|${s}`]));
  }

  #onMessage(m: WsMessage): void {
    if (m.text === 'pong') return;
    let msg: {
      action?: string;
      arg?: { channel?: string; instId?: string };
      data?: Record<string, unknown>[];
      event?: string;
      code?: number | string;
      msg?: string;
    };
    try {
      msg = JSON.parse(m.text);
    } catch {
      this.log.warn({ connection: m.connection }, 'non-JSON message');
      return;
    }
    if (msg.arg?.channel === 'ticker' && Array.isArray(msg.data)) {
      for (const t of msg.data) {
        this.push({
          symbol: String(t.instId ?? msg.arg.instId),
          values: parseTicker(t),
          exchangeTs: Number(t.ts) || null,
          receivedAt: m.receivedAt,
          connection: m.connection,
        });
      }
      return;
    }
    // Only live updates: the snapshot sent on (re)subscribe repeats past trades.
    if (msg.arg?.channel === 'trade' && msg.action === 'update' && msg.arg.instId) {
      for (const t of parseTrades(msg.arg.instId, msg.data)) this.pushTrade(t);
      return;
    }
    if (msg.event === 'error') {
      this.log.warn({ code: msg.code, msg: msg.msg }, 'subscription rejected');
      this.setDetail(`subscription rejected: ${msg.msg ?? msg.code ?? 'unknown'}`);
    }
  }
}
