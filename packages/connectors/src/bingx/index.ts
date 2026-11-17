import type { ExchangeCapabilities, MarketsBootstrap, MarketUpdate } from '@mip/core';
import { BaseConnector, type ConnectorContext } from '../base/connector.js';
import { sharedRateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { SubscriptionManager } from '../base/subscriptions.js';
import { gunzipDecoder, type WsMessage } from '../base/ws-client.js';
import {
  isCryptoUsdtPerp,
  openInterestToBase,
  parsePremiumIndex,
  parseStreamEvent,
  parseTicker,
  parseTrades,
  toInstrument,
  type BingxContract,
} from './parse.js';

const REST_URL = 'https://open-api.bingx.com';
const WS_URL = 'wss://open-api-swap.bingx.com/swap-market';
const STREAMS = ['bookTicker', 'markPrice', 'ticker'] as const;
/** Index price and funding exist only in the bulk REST premiumIndex (the WS mark stream has mark only). */
const PREMIUM_POLL_MS = 5_000;
/** Open interest requires one request per symbol. */
const OI_SWEEP_MS = 60_000;

const WS_CHANGE = { source: 'ws', refresh: 'change', maxAgeMs: 300_000 } as const;
const PREMIUM = {
  source: 'rest',
  refresh: 'interval',
  maxAgeMs: 30_000,
  note: `REST premiumIndex every ${PREMIUM_POLL_MS / 1000} s`,
} as const;

export const BINGX_CAPABILITIES: ExchangeCapabilities = {
  last: WS_CHANGE,
  mark: WS_CHANGE,
  index: PREMIUM,
  bid: WS_CHANGE,
  ask: WS_CHANGE,
  bidSize: WS_CHANGE,
  askSize: WS_CHANGE,
  openInterest: {
    source: 'derived',
    refresh: 'interval',
    maxAgeMs: 3 * OI_SWEEP_MS,
    note: `REST poll every ${OI_SWEEP_MS / 1000} s; published as USDT notional, divided by mark price`,
  },
  fundingRate: PREMIUM,
  fundingIntervalHours: PREMIUM,
  nextFundingTime: PREMIUM,
  turnover24h: WS_CHANGE,
};

interface BingxResponse<T> {
  code: number;
  msg: string;
  data: T;
}

/**
 * BingX Swap V2. Every WS frame is GZIP-compressed; the server sends "Ping" every 5 s and
 * expects "Pong". Limits: 200 topics per socket, 60 sockets per IP; market REST 500 / 10 s.
 */
export class BingxConnector extends BaseConnector {
  readonly exchange = 'bingx' as const;
  readonly capabilities = BINGX_CAPABILITIES;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  #stream: SubscriptionManager | null = null;
  /** Latest mark per symbol, for converting open interest. */
  readonly #marks = new Map<string, number>();

  constructor(ctx: ConnectorContext, endpoints: { restUrl?: string; wsUrl?: string } = {}) {
    super(ctx, 'bingx');
    this.#wsUrl = endpoints.wsUrl ?? WS_URL;
    this.#rest = this.registerRest(
      new RestClient({
        exchange: 'bingx',
        baseUrl: endpoints.restUrl ?? REST_URL,
        limiter: sharedRateLimiter({ name: 'bingx/rest', windows: [{ limit: 500, windowMs: 10_000 }] }),
        logger: this.log,
        checkBody: (body) => {
          const b = body as Partial<BingxResponse<unknown>> | null;
          if (!b || typeof b.code !== 'number' || b.code === 0) return null;
          return { code: b.code, message: b.msg ?? '' };
        },
      }),
    );
  }

  async loadMarkets(): Promise<MarketsBootstrap> {
    const [contracts, premium, tickers] = await Promise.all([
      this.#rest.get<BingxResponse<BingxContract[]>>('/openApi/swap/v2/quote/contracts'),
      this.#rest.get<BingxResponse<Record<string, unknown>[]>>('/openApi/swap/v2/quote/premiumIndex'),
      this.#rest.get<BingxResponse<Record<string, unknown>[]>>('/openApi/swap/v2/quote/ticker'),
    ]);
    const instruments = contracts.data.filter(isCryptoUsdtPerp).map(toInstrument);
    const listed = new Set(instruments.map((i) => i.symbol));
    const receivedAt = Date.now();
    const updates: MarketUpdate[] = [];
    for (const r of premium.data) {
      const symbol = String(r.symbol);
      if (!listed.has(symbol)) continue;
      const values = parsePremiumIndex(r);
      if (values.mark) this.#marks.set(symbol, values.mark);
      updates.push({ symbol, values, exchangeTs: null, receivedAt, connection: null });
    }
    for (const r of tickers.data) {
      const symbol = String(r.symbol);
      if (listed.has(symbol))
        updates.push({ symbol, values: parseTicker(r), exchangeTs: null, receivedAt, connection: null });
    }
    return { instruments, updates };
  }

  protected async onStart(): Promise<void> {
    const encode = (reqType: string) => (topics: readonly string[]) =>
      topics.map((t) => JSON.stringify({ id: `${reqType}:${t}`, reqType, dataType: t }));
    const stream = new SubscriptionManager({
      name: 'bingx/swap',
      url: this.#wsUrl,
      maxTopicsPerConnection: 180,
      maxConnections: 20,
      logger: this.log,
      protocol: { subscribe: encode('sub'), unsubscribe: encode('unsub') },
      // One topic per request; pace them.
      sendRate: { limit: 20, windowMs: 1_000 },
      socket: { decode: gunzipDecoder, serverPing: (text) => (text === 'Ping' ? 'Pong' : null) },
    });
    stream.on('message', (m) => this.#onMessage(m));
    this.#stream = this.registerStream(stream);
    stream.add(this.#topics(this.tracked()));
    stream.start();
    this.every('premium-index', PREMIUM_POLL_MS, () => this.#pollPremium(), { runNow: true });
    this.every('open-interest', OI_SWEEP_MS, () => this.#sweepOpenInterest(), { runNow: true });
  }

  protected onTrackedChanged(added: string[], removed: string[]): void {
    this.#stream?.add(this.#topics(added));
    this.#stream?.remove(this.#topics(removed));
  }

  #topics(symbols: string[]): string[] {
    const streams: string[] = this.wantsTrades ? [...STREAMS, 'trade'] : [...STREAMS];
    return symbols.flatMap((s) => streams.map((t) => `${s}@${t}`));
  }

  #onMessage(m: WsMessage): void {
    let msg: {
      dataType?: string;
      data?: (Record<string, unknown> & unknown[]) | null;
      code?: number;
      msg?: string;
      id?: string;
    };
    try {
      msg = JSON.parse(m.text);
    } catch {
      this.log.warn({ connection: m.connection }, 'non-JSON message');
      return;
    }
    if (msg.dataType?.endsWith('@trade')) {
      for (const t of parseTrades(msg.data)) this.pushTrade(t);
      return;
    }
    if (msg.dataType && msg.data) {
      const ev = parseStreamEvent(msg.data);
      if (!ev) return;
      if (ev.values.mark) this.#marks.set(ev.symbol, ev.values.mark);
      this.push({
        symbol: ev.symbol,
        values: ev.values,
        exchangeTs: ev.ts,
        receivedAt: m.receivedAt,
        connection: m.connection,
      });
      return;
    }
    if (msg.id && msg.code !== undefined && msg.code !== 0) {
      this.log.warn({ id: msg.id, code: msg.code, msg: msg.msg }, 'subscription rejected');
      this.setDetail(`subscription rejected: ${msg.msg || msg.code}`);
    }
  }

  async #pollPremium(): Promise<void> {
    const res = await this.#rest.get<BingxResponse<Record<string, unknown>[]>>(
      '/openApi/swap/v2/quote/premiumIndex',
      undefined,
      {
        priority: 'high',
      },
    );
    const receivedAt = Date.now();
    for (const r of res.data) {
      const symbol = String(r.symbol);
      if (!this.isTracked(symbol)) continue;
      const values = parsePremiumIndex(r);
      // The mark price also comes over WS; keep the premiumIndex fields that only REST has.
      delete values.mark;
      this.push({ symbol, values, exchangeTs: null, receivedAt, connection: null });
    }
  }

  async #sweepOpenInterest(): Promise<void> {
    for (const symbol of this.tracked()) {
      if (this.stopped) return;
      try {
        const res = await this.#rest.get<BingxResponse<{ openInterest?: string; time?: number }>>(
          '/openApi/swap/v2/quote/openInterest',
          { symbol },
          { priority: 'low' },
        );
        const mark = this.#marks.get(symbol);
        const notional = Number(res.data?.openInterest);
        const oi = mark === undefined ? undefined : openInterestToBase(notional, mark);
        if (oi === undefined) continue;
        this.push({
          symbol,
          values: { openInterest: oi },
          exchangeTs: typeof res.data.time === 'number' ? res.data.time : null,
          receivedAt: Date.now(),
          connection: null,
        });
      } catch (err) {
        this.log.debug({ symbol, err: (err as Error).message }, 'open interest request failed');
      }
    }
  }
}
