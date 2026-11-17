import type { ExchangeCapabilities, InstrumentInfo, MarketsBootstrap, MarketUpdate } from '@mip/core';
import { BaseConnector, type ConnectorContext } from '../base/connector.js';
import { sharedRateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { batchMessages, SubscriptionManager } from '../base/subscriptions.js';
import type { WsMessage } from '../base/ws-client.js';
import { isCryptoUsdtPerp, parseTicker, parseTrades, toInstrument, type BybitInstrument } from './parse.js';

const REST_URL = 'https://api.bybit.com';
const WS_URL = 'wss://stream.bybit.com/v5/public/linear';

/**
 * Ticker deltas are pushed only when a field changes, so a quiet contract can be silent for a
 * minute or more (observed live). Connection loss is caught separately; this limit only guards
 * against a subscription that silently stops delivering.
 */
const WS_CHANGE = { source: 'ws', refresh: 'change', maxAgeMs: 300_000 } as const;

/** Bybit V5 linear tickers carry every field we need over one snapshot + delta stream. */
export const BYBIT_CAPABILITIES: ExchangeCapabilities = {
  last: WS_CHANGE,
  mark: WS_CHANGE,
  index: WS_CHANGE,
  bid: WS_CHANGE,
  ask: WS_CHANGE,
  bidSize: WS_CHANGE,
  askSize: WS_CHANGE,
  openInterest: { ...WS_CHANGE, note: 'singleOpenInterest (one side)' },
  fundingRate: WS_CHANGE,
  fundingIntervalHours: WS_CHANGE,
  nextFundingTime: WS_CHANGE,
  turnover24h: WS_CHANGE,
};

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

/**
 * Bybit V5 (linear USDT perpetuals).
 * Limits: REST 600 requests / 5 s per IP, exceeding it returns HTTP 403 and a ban of at least
 * 10 minutes. WS: ping every 20 s; one subscribe request must stay under 21,000 characters.
 */
export class BybitConnector extends BaseConnector {
  readonly exchange = 'bybit' as const;
  readonly capabilities = BYBIT_CAPABILITIES;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  #stream: SubscriptionManager | null = null;

  constructor(ctx: ConnectorContext, endpoints: { restUrl?: string; wsUrl?: string } = {}) {
    super(ctx, 'bybit');
    this.#wsUrl = endpoints.wsUrl ?? WS_URL;
    this.#rest = this.registerRest(
      new RestClient({
        exchange: 'bybit',
        baseUrl: endpoints.restUrl ?? REST_URL,
        limiter: sharedRateLimiter({ name: 'bybit/rest', windows: [{ limit: 600, windowMs: 5_000 }] }),
        logger: this.log,
        statusPolicy: { 403: { kind: 'banned', pauseMs: 10 * 60_000 } },
        checkBody: (body) => {
          const b = body as Partial<BybitResponse<unknown>> | null;
          if (!b || typeof b.retCode !== 'number' || b.retCode === 0) return null;
          // 10006: too many visits; 10018: IP rate limit exceeded
          const limited = b.retCode === 10006 || b.retCode === 10018;
          return { code: b.retCode, message: b.retMsg ?? '', ...(limited ? { kind: 'rate_limited' } : {}) };
        },
      }),
    );
  }

  async loadMarkets(): Promise<MarketsBootstrap> {
    const rows: BybitInstrument[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const res = await this.#rest.get<BybitResponse<{ list: BybitInstrument[]; nextPageCursor?: string }>>(
        '/v5/market/instruments-info',
        { category: 'linear', limit: 1000, ...(cursor ? { cursor } : {}) },
      );
      rows.push(...res.result.list);
      cursor = res.result.nextPageCursor ?? '';
      if (!cursor) break;
    }
    const instruments: InstrumentInfo[] = rows.filter(isCryptoUsdtPerp).map(toInstrument);
    const listed = new Set(instruments.map((i) => i.symbol));

    const tickers = await this.#rest.get<BybitResponse<{ list: Record<string, unknown>[] }>>(
      '/v5/market/tickers',
      { category: 'linear' },
    );
    const receivedAt = Date.now();
    const updates: MarketUpdate[] = tickers.result.list
      .filter((t) => listed.has(String(t.symbol)))
      .map((t) => ({
        symbol: String(t.symbol),
        values: parseTicker(t),
        exchangeTs: tickers.time,
        receivedAt,
        connection: null,
      }));
    return { instruments, updates };
  }

  protected async onStart(): Promise<void> {
    const stream = new SubscriptionManager({
      name: 'bybit/linear',
      url: this.#wsUrl,
      maxTopicsPerConnection: 500,
      maxConnections: 10,
      logger: this.log,
      protocol: {
        subscribe: (topics) =>
          batchMessages(topics, { maxItems: 200, maxBytes: 20_000 }, (args) =>
            JSON.stringify({ op: 'subscribe', args }),
          ),
        unsubscribe: (topics) =>
          batchMessages(topics, { maxItems: 200, maxBytes: 20_000 }, (args) =>
            JSON.stringify({ op: 'unsubscribe', args }),
          ),
      },
      socket: { heartbeat: { intervalMs: 20_000, message: () => '{"op":"ping"}' } },
    });
    stream.on('message', (m) => this.#onMessage(m));
    this.#stream = this.registerStream(stream);
    stream.add(this.#topics(this.tracked()));
    stream.start();
  }

  protected onTrackedChanged(added: string[], removed: string[]): void {
    // Add first so a connection never runs empty (an empty connection is closed).
    this.#stream?.add(this.#topics(added));
    this.#stream?.remove(this.#topics(removed));
  }

  #topics(symbols: string[]): string[] {
    return symbols.flatMap((s) =>
      this.wantsTrades ? [`tickers.${s}`, `publicTrade.${s}`] : [`tickers.${s}`],
    );
  }

  #onMessage(m: WsMessage): void {
    let msg: {
      topic?: string;
      ts?: number;
      data?: Record<string, unknown> & unknown[];
      op?: string;
      success?: boolean;
      ret_msg?: string;
    };
    try {
      msg = JSON.parse(m.text);
    } catch {
      this.log.warn({ connection: m.connection }, 'non-JSON message');
      return;
    }
    if (msg.topic?.startsWith('tickers.') && msg.data) {
      this.push({
        symbol: String(msg.data.symbol ?? msg.topic.slice(8)),
        values: parseTicker(msg.data),
        exchangeTs: typeof msg.ts === 'number' ? msg.ts : null,
        receivedAt: m.receivedAt,
        connection: m.connection,
      });
      return;
    }
    if (msg.topic?.startsWith('publicTrade.')) {
      for (const t of parseTrades(msg.data)) this.pushTrade(t);
      return;
    }
    if (msg.op === 'subscribe' && msg.success === false) {
      this.log.warn({ reason: msg.ret_msg }, 'subscription rejected');
      this.setDetail(`subscription rejected: ${msg.ret_msg ?? 'unknown reason'}`);
    }
  }
}
