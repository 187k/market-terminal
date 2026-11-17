import type { ExchangeCapabilities, MarketsBootstrap, MarketUpdate } from '@mip/core';
import { BaseConnector, type ConnectorContext } from '../base/connector.js';
import { sharedRateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { SubscriptionManager } from '../base/subscriptions.js';
import type { WsMessage } from '../base/ws-client.js';
import {
  isCryptoUsdtPerp,
  parseDeals,
  parseFundingRate,
  parseTicker,
  toInstrument,
  type MexcContract,
} from './parse.js';

/** Futures "Access URL" in the MEXC docs (integration guide). */
const REST_URL = 'https://api.mexc.com';
/** JSON endpoint from the docs ("Native ws endpoint"). Can be overridden with MEXC_WS_URL. */
const WS_URL = 'wss://contract.mexc.com/edge';
/** Funding interval and next settlement are not in the ticker stream. */
const FUNDING_POLL_MS = 60_000;

const WS_CHANGE = { source: 'ws', refresh: 'change', maxAgeMs: 300_000 } as const;
const FUNDING = {
  source: 'rest',
  refresh: 'interval',
  maxAgeMs: 3 * FUNDING_POLL_MS,
  note: `REST funding_rate every ${FUNDING_POLL_MS / 1000} s`,
} as const;
const NO_SIZE = {
  source: 'none',
  reason: 'not_implemented',
  note: 'the ticker has no sizes; they exist only in the depth stream, which this version does not subscribe to',
} as const;

export const MEXC_CAPABILITIES: ExchangeCapabilities = {
  last: WS_CHANGE,
  mark: { ...WS_CHANGE, note: 'fairPrice' },
  index: WS_CHANGE,
  bid: WS_CHANGE,
  ask: WS_CHANGE,
  bidSize: NO_SIZE,
  askSize: NO_SIZE,
  openInterest: { ...WS_CHANGE, note: 'holdVol (contracts) × contractSize' },
  fundingRate: WS_CHANGE,
  fundingIntervalHours: FUNDING,
  nextFundingTime: FUNDING,
  turnover24h: WS_CHANGE,
};

interface MexcResponse<T> {
  success: boolean;
  code: number;
  message?: string;
  data: T;
}

/**
 * MEXC futures (USDT-M perpetuals), JSON WebSocket.
 * The per-symbol `sub.ticker` channel carries price, bid/ask, mark, index, funding and open
 * interest; the all-symbols `sub.tickers` channel lacks bid/ask, OI and funding, so it is not used.
 * Subscription limits per connection are not documented; topics are spread conservatively.
 */
export class MexcConnector extends BaseConnector {
  readonly exchange = 'mexc' as const;
  readonly capabilities = MEXC_CAPABILITIES;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  #stream: SubscriptionManager | null = null;
  #sizes = new Map<string, number>();

  constructor(ctx: ConnectorContext, endpoints: { restUrl?: string; wsUrl?: string } = {}) {
    super(ctx, 'mexc');
    this.#wsUrl = endpoints.wsUrl ?? WS_URL;
    this.#rest = this.registerRest(
      new RestClient({
        exchange: 'mexc',
        baseUrl: endpoints.restUrl ?? REST_URL,
        // Bulk ticker: 10 requests / 2 s; funding rate: 20 / 2 s (docs).
        limiter: sharedRateLimiter({ name: 'mexc/rest', windows: [{ limit: 10, windowMs: 2_000 }] }),
        logger: this.log,
        checkBody: (body) => {
          const b = body as Partial<MexcResponse<unknown>> | null;
          if (!b || b.success !== false) return null;
          return {
            code: b.code ?? 'unknown',
            message: b.message ?? '',
            ...(b.code === 510 ? { kind: 'rate_limited' } : {}),
          };
        },
      }),
    );
  }

  async loadMarkets(): Promise<MarketsBootstrap> {
    const [detail, tickers, funding] = await Promise.all([
      this.#rest.get<MexcResponse<MexcContract[]>>('/api/v1/contract/detail'),
      this.#rest.get<MexcResponse<Record<string, unknown>[]>>('/api/v1/contract/ticker'),
      this.#fundingRates(),
    ]);
    const instruments = detail.data.filter(isCryptoUsdtPerp).map(toInstrument);
    this.#sizes = new Map(instruments.map((i) => [i.symbol, i.contractSize]));
    const receivedAt = Date.now();
    const updates: MarketUpdate[] = [];
    for (const t of tickers.data) {
      const symbol = String(t.symbol);
      const size = this.#sizes.get(symbol);
      if (size !== undefined)
        updates.push({
          symbol,
          values: parseTicker(t, size),
          exchangeTs: null,
          receivedAt,
          connection: null,
        });
    }
    for (const r of funding) {
      const symbol = String(r.symbol);
      if (this.#sizes.has(symbol))
        updates.push({ symbol, values: parseFundingRate(r), exchangeTs: null, receivedAt, connection: null });
    }
    return { instruments, updates };
  }

  protected async onStart(): Promise<void> {
    // Topics are "ticker|SYMBOL" or "deal|SYMBOL" -> sub.ticker / sub.deal.
    const encode = (prefix: 'sub' | 'unsub') => (topics: readonly string[]) =>
      topics.map((t) => {
        const [channel, symbol] = t.split('|');
        return JSON.stringify({ method: `${prefix}.${channel}`, param: { symbol } });
      });
    const stream = new SubscriptionManager({
      name: 'mexc/contract',
      url: this.#wsUrl,
      maxTopicsPerConnection: 50,
      maxConnections: 20,
      logger: this.log,
      protocol: { subscribe: encode('sub'), unsubscribe: encode('unsub') },
      sendRate: { limit: 10, windowMs: 1_000 },
      // Docs: the server closes a connection after 1 minute without a ping; ping every 10–20 s.
      socket: { heartbeat: { intervalMs: 15_000, message: () => '{"method":"ping"}' } },
    });
    stream.on('message', (m) => this.#onMessage(m));
    this.#stream = this.registerStream(stream);
    stream.add(this.#topics(this.tracked()));
    stream.start();
    this.every('funding', FUNDING_POLL_MS, () => this.#pollFunding());
  }

  protected onTrackedChanged(added: string[], removed: string[]): void {
    this.#stream?.add(this.#topics(added));
    this.#stream?.remove(this.#topics(removed));
  }

  #topics(symbols: string[]): string[] {
    return symbols.flatMap((s) => (this.wantsTrades ? [`ticker|${s}`, `deal|${s}`] : [`ticker|${s}`]));
  }

  /**
   * Without a symbol the endpoint returned every contract when probed on 2026-11-16 (the docs
   * describe only the per-symbol form); falls back to per-symbol requests otherwise.
   */
  async #fundingRates(): Promise<Record<string, unknown>[]> {
    const res = await this.#rest.get<MexcResponse<Record<string, unknown>[] | Record<string, unknown>>>(
      '/api/v1/contract/funding_rate',
    );
    if (Array.isArray(res.data)) return res.data;
    const out: Record<string, unknown>[] = [];
    for (const symbol of this.tracked()) {
      const one = await this.#rest.get<MexcResponse<Record<string, unknown>>>(
        `/api/v1/contract/funding_rate/${symbol}`,
        undefined,
        {
          priority: 'low',
        },
      );
      out.push(one.data);
    }
    return out;
  }

  async #pollFunding(): Promise<void> {
    const rows = await this.#fundingRates();
    const receivedAt = Date.now();
    for (const r of rows) {
      const symbol = String(r.symbol);
      if (this.isTracked(symbol))
        this.push({ symbol, values: parseFundingRate(r), exchangeTs: null, receivedAt, connection: null });
    }
  }

  #onMessage(m: WsMessage): void {
    let msg: { channel?: string; data?: unknown; symbol?: string; ts?: number };
    try {
      msg = JSON.parse(m.text);
    } catch {
      this.log.warn({ connection: m.connection }, 'non-JSON message');
      return;
    }
    if (msg.channel === 'push.ticker' && msg.data && typeof msg.data === 'object') {
      const d = msg.data as Record<string, unknown>;
      const symbol = String(d.symbol ?? msg.symbol);
      const size = this.#sizes.get(symbol);
      if (size === undefined) return;
      this.push({
        symbol,
        values: parseTicker(d, size),
        exchangeTs: typeof d.timestamp === 'number' ? d.timestamp : (msg.ts ?? null),
        receivedAt: m.receivedAt,
        connection: m.connection,
      });
      return;
    }
    if (msg.channel === 'push.deal' && typeof msg.symbol === 'string') {
      const size = this.#sizes.get(msg.symbol);
      if (size === undefined) return;
      for (const t of parseDeals(msg.symbol, msg.data, size)) this.pushTrade(t);
      return;
    }
    if (msg.channel === 'rs.error' || (msg.channel?.startsWith('rs.sub') && msg.data !== 'success')) {
      this.log.warn({ channel: msg.channel, data: msg.data }, 'subscription rejected');
      this.setDetail(`subscription rejected: ${String(msg.data).slice(0, 160)}`);
    }
  }
}
