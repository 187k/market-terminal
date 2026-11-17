import type { ExchangeCapabilities, MarketsBootstrap, MarketUpdate } from '@mip/core';
import { BaseConnector, type ConnectorContext } from '../base/connector.js';
import { sharedRateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { batchMessages, SubscriptionManager, type SubscriptionProtocol } from '../base/subscriptions.js';
import type { WsMessage } from '../base/ws-client.js';
import {
  DEFAULT_FUNDING_INTERVAL_HOURS,
  fundingIntervals,
  isCryptoUsdtPerp,
  maxLeverageBySymbol,
  parseAggTrade,
  parseBookTicker,
  parsePremiumIndex,
  parseStreamEvent,
  parseTicker24h,
  signQuery,
  toInstrument,
  type BinanceSymbol,
} from './parse.js';

const REST_URL = 'https://fapi.binance.com';
/** Since 2026 streams are routed: book data under /public, mark price and tickers under /market. */
const WS_PUBLIC_URL = 'wss://fstream.binance.com/public/stream';
const WS_MARKET_URL = 'wss://fstream.binance.com/market/stream';

/** Open interest has no stream and no bulk call: one weight-1 request per symbol. */
const OI_SWEEP_MS = 30_000;

const WS_FAST = { source: 'ws', refresh: 'interval', maxAgeMs: 10_000 } as const;
/** The per-symbol 24 h ticker pushes at most every 2 s and only when something changed (observed live). */
const WS_TICKER = { source: 'ws', refresh: 'change', maxAgeMs: 60_000 } as const;

export const BINANCE_CAPABILITIES: ExchangeCapabilities = {
  last: { ...WS_TICKER, note: '24 h ticker stream: every 2 s when it changes' },
  mark: { ...WS_FAST, note: 'mark price stream, every 1 s' },
  index: WS_FAST,
  // Top-5 depth every 500 ms, but a quiet book can go more than 10 s without a push (observed in a soak).
  bid: { ...WS_TICKER, note: 'top-5 depth snapshot, every 500 ms when it changes' },
  ask: WS_TICKER,
  bidSize: WS_TICKER,
  askSize: WS_TICKER,
  openInterest: {
    source: 'rest',
    refresh: 'interval',
    maxAgeMs: 120_000,
    note: `REST poll every ${OI_SWEEP_MS / 1000} s; no stream exists`,
  },
  fundingRate: WS_FAST,
  fundingIntervalHours: {
    source: 'rest',
    refresh: 'interval',
    maxAgeMs: 60 * 60_000,
    note: `${DEFAULT_FUNDING_INTERVAL_HOURS} h unless fundingInfo lists an adjusted interval`,
  },
  nextFundingTime: WS_FAST,
  turnover24h: WS_TICKER,
};

export interface BinanceEndpoints {
  restUrl?: string;
  wsPublicUrl?: string;
  wsMarketUrl?: string;
}

/**
 * Binance USDⓈ-M futures.
 * Limits: REST 2,400 weight / min per IP (HTTP 429, then 418 bans). WS: 1,024 streams and
 * 10 incoming messages / s per connection, forced disconnect after 24 h.
 */
export class BinanceConnector extends BaseConnector {
  readonly exchange = 'binance' as const;
  readonly capabilities = BINANCE_CAPABILITIES;
  readonly #rest: RestClient;
  readonly #urls: Required<BinanceEndpoints>;
  #public: SubscriptionManager | null = null;
  #market: SubscriptionManager | null = null;
  #intervals = new Map<string, number>();

  constructor(ctx: ConnectorContext, endpoints: BinanceEndpoints = {}) {
    super(ctx, 'binance');
    this.#urls = {
      restUrl: endpoints.restUrl ?? REST_URL,
      wsPublicUrl: endpoints.wsPublicUrl ?? WS_PUBLIC_URL,
      wsMarketUrl: endpoints.wsMarketUrl ?? WS_MARKET_URL,
    };
    this.#rest = this.registerRest(
      new RestClient({
        exchange: 'binance',
        baseUrl: this.#urls.restUrl,
        limiter: sharedRateLimiter({ name: 'binance/rest', windows: [{ limit: 2_400, windowMs: 60_000 }] }),
        logger: this.log,
      }),
    );
  }

  async loadMarkets(): Promise<MarketsBootstrap> {
    const info = await this.#rest.get<{ symbols: BinanceSymbol[] }>('/fapi/v1/exchangeInfo', undefined, {
      weight: 1,
    });
    const symbols = info.symbols.filter(isCryptoUsdtPerp);
    const leverage = await this.#loadLeverage();
    const instruments = symbols.map((s) =>
      toInstrument(s, leverage?.get(s.symbol), this.credentials !== undefined),
    );
    const listed = new Set(instruments.map((i) => i.symbol));

    const [premium, tickers, books, funding] = await Promise.all([
      this.#rest.get<Record<string, unknown>[]>('/fapi/v1/premiumIndex', undefined, { weight: 10 }),
      this.#rest.get<Record<string, unknown>[]>('/fapi/v1/ticker/24hr', undefined, { weight: 40 }),
      this.#rest.get<Record<string, unknown>[]>('/fapi/v1/ticker/bookTicker', undefined, { weight: 5 }),
      this.#rest.get<{ symbol: string; fundingIntervalHours?: number }[]>('/fapi/v1/fundingInfo'),
    ]);
    this.#intervals = fundingIntervals(funding);
    const receivedAt = Date.now();
    const updates: MarketUpdate[] = [];
    const add = (rows: Record<string, unknown>[], parse: typeof parseTicker24h, tsKey: string) => {
      for (const r of rows) {
        const symbol = String(r.symbol);
        if (!listed.has(symbol)) continue;
        const ts = r[tsKey];
        updates.push({
          symbol,
          values: parse(r),
          exchangeTs: typeof ts === 'number' ? ts : null,
          receivedAt,
          connection: null,
        });
      }
    };
    add(premium, parsePremiumIndex, 'time');
    add(tickers, parseTicker24h, 'closeTime');
    add(books, parseBookTicker, 'time');
    for (const symbol of listed) {
      updates.push({
        symbol,
        values: { fundingIntervalHours: this.#intervals.get(symbol) ?? DEFAULT_FUNDING_INTERVAL_HOURS },
        exchangeTs: null,
        receivedAt,
        connection: null,
      });
    }
    return { instruments, updates };
  }

  protected async onStart(): Promise<void> {
    const protocol = this.#protocol();
    const common = {
      maxTopicsPerConnection: 200,
      maxConnections: 5,
      protocol,
      logger: this.log,
      // The exchange allows 10 incoming messages / s per connection.
      sendRate: { limit: 5, windowMs: 1_000 },
      // Connections are cut after 24 h; rotate a little earlier with overlap.
      socket: { maxLifetimeMs: 23 * 60 * 60_000 },
    };
    this.#public = this.registerStream(
      new SubscriptionManager({ ...common, name: 'binance/public', url: this.#urls.wsPublicUrl }),
    );
    this.#market = this.registerStream(
      new SubscriptionManager({ ...common, name: 'binance/market', url: this.#urls.wsMarketUrl }),
    );
    for (const s of [this.#public, this.#market]) {
      s.on('message', (m) => this.#onMessage(m));
    }
    this.#subscribe(this.tracked());
    this.#public.start();
    this.#market.start();
    this.every('open-interest', OI_SWEEP_MS, () => this.#sweepOpenInterest(), { runNow: true });
  }

  protected onTrackedChanged(added: string[], removed: string[]): void {
    // Add first so a connection never runs empty (an empty connection is closed).
    this.#subscribe(added);
    const lower = removed.map((s) => s.toLowerCase());
    this.#public?.remove(lower.map((s) => `${s}@depth5@500ms`));
    this.#market?.remove(lower.flatMap((s) => this.#marketTopics(s)));
  }

  #subscribe(symbols: string[]): void {
    const lower = symbols.map((s) => s.toLowerCase());
    this.#public?.add(lower.map((s) => `${s}@depth5@500ms`));
    this.#market?.add(lower.flatMap((s) => this.#marketTopics(s)));
  }

  #marketTopics(s: string): string[] {
    const topics = [`${s}@markPrice@1s`, `${s}@ticker`];
    if (this.wantsTrades) topics.push(`${s}@aggTrade`);
    return topics;
  }

  #protocol(): SubscriptionProtocol {
    let id = 0;
    const encode = (method: string) => (params: string[]) => JSON.stringify({ method, params, id: ++id });
    return {
      subscribe: (topics) => batchMessages(topics, { maxItems: 100 }, encode('SUBSCRIBE')),
      unsubscribe: (topics) => batchMessages(topics, { maxItems: 100 }, encode('UNSUBSCRIBE')),
    };
  }

  #onMessage(m: WsMessage): void {
    let msg: { data?: Record<string, unknown>; error?: { code?: number; msg?: string } };
    try {
      msg = JSON.parse(m.text);
    } catch {
      this.log.warn({ connection: m.connection }, 'non-JSON message');
      return;
    }
    if (msg.data) {
      if (msg.data.e === 'aggTrade') {
        const t = parseAggTrade(msg.data);
        if (t) this.pushTrade(t);
        return;
      }
      const ev = parseStreamEvent(msg.data);
      if (ev)
        this.push({
          symbol: ev.symbol,
          values: ev.values,
          exchangeTs: ev.ts,
          receivedAt: m.receivedAt,
          connection: m.connection,
        });
      return;
    }
    if (msg.error) {
      this.log.warn({ error: msg.error }, 'subscription request rejected');
      this.setDetail(`subscription rejected: ${msg.error.msg ?? msg.error.code ?? 'unknown'}`);
    }
  }

  async #sweepOpenInterest(): Promise<void> {
    for (const symbol of this.tracked()) {
      if (this.stopped) return;
      try {
        const r = await this.#rest.get<{ openInterest?: string; time?: number }>(
          '/fapi/v1/openInterest',
          { symbol },
          { priority: 'low' },
        );
        const oi = Number(r.openInterest);
        if (!Number.isFinite(oi)) continue;
        this.push({
          symbol,
          values: { openInterest: oi },
          exchangeTs: typeof r.time === 'number' ? r.time : null,
          receivedAt: Date.now(),
          connection: null,
        });
      } catch (err) {
        this.log.debug({ symbol, err: (err as Error).message }, 'open interest request failed');
      }
    }
  }

  /** Max leverage needs a key (USER_DATA). Returns null when no key is configured or the call fails. */
  async #loadLeverage(): Promise<Map<string, number> | null> {
    if (!this.credentials) return null;
    try {
      const query = new URLSearchParams({ recvWindow: '5000', timestamp: String(Date.now()) }).toString();
      const signature = signQuery(query, this.credentials.apiSecret);
      const rows = await this.#rest.get<{ symbol: string; brackets?: { initialLeverage?: number }[] }[]>(
        '/fapi/v1/leverageBracket',
        { ...Object.fromEntries(new URLSearchParams(query)), signature },
        { headers: { 'X-MBX-APIKEY': this.credentials.apiKey } },
      );
      return maxLeverageBySymbol(rows);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'leverage brackets unavailable');
      return null;
    }
  }
}
