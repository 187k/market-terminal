import type { ExchangeCapabilities, InstrumentInfo, MarketsBootstrap, MarketUpdate } from '@mip/core';
import { BaseConnector, type ConnectorContext } from '../base/connector.js';
import { sharedRateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { SubscriptionManager } from '../base/subscriptions.js';
import type { WsMessage } from '../base/ws-client.js';
import {
  lastTrade,
  parseAssetCtx,
  parseBbo,
  parseTrades,
  toInstrument,
  type HlUniverseEntry,
} from './parse.js';

const REST_URL = 'https://api.hyperliquid.xyz';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const SUBSCRIPTIONS = ['activeAssetCtx', 'bbo', 'trades'] as const;

const WS_CHANGE = { source: 'ws', refresh: 'change', maxAgeMs: 300_000 } as const;

export const HYPERLIQUID_CAPABILITIES: ExchangeCapabilities = {
  last: { ...WS_CHANGE, note: 'price of the latest trade' },
  mark: { ...WS_CHANGE, note: 'median that includes other venues’ perp prices' },
  index: { ...WS_CHANGE, note: 'oracle price (Hyperliquid has no index price)' },
  bid: WS_CHANGE,
  ask: WS_CHANGE,
  bidSize: WS_CHANGE,
  askSize: WS_CHANGE,
  openInterest: { ...WS_CHANGE, note: 'base coin' },
  fundingRate: { ...WS_CHANGE, note: 'hourly rate' },
  fundingIntervalHours: { source: 'derived', note: 'fixed 1 h (documented)' },
  nextFundingTime: { source: 'derived', note: 'next full hour (funding is paid hourly)' },
  turnover24h: { ...WS_CHANGE, note: 'USDC notional' },
};

/**
 * Hyperliquid (main perp dex; builder-deployed dexes are not loaded). Everything public via
 * POST /info and one WebSocket. Limits: REST 1,200 weight / min per IP (metaAndAssetCtxs = 20);
 * WS max 10 connections and 1,000 subscriptions per IP, 2,000 client messages / min.
 */
export class HyperliquidConnector extends BaseConnector {
  readonly exchange = 'hyperliquid' as const;
  readonly capabilities = HYPERLIQUID_CAPABILITIES;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  #stream: SubscriptionManager | null = null;

  constructor(ctx: ConnectorContext, endpoints: { restUrl?: string; wsUrl?: string } = {}) {
    super(ctx, 'hyperliquid');
    this.#wsUrl = endpoints.wsUrl ?? WS_URL;
    this.#rest = this.registerRest(
      new RestClient({
        exchange: 'hyperliquid',
        baseUrl: endpoints.restUrl ?? REST_URL,
        limiter: sharedRateLimiter({
          name: 'hyperliquid/rest',
          windows: [{ limit: 1_200, windowMs: 60_000 }],
        }),
        logger: this.log,
      }),
    );
  }

  async loadMarkets(): Promise<MarketsBootstrap> {
    const [meta, ctxs] = await this.#rest.request<
      [{ universe: HlUniverseEntry[] }, Record<string, unknown>[]]
    >({
      method: 'POST',
      path: '/info',
      body: { type: 'metaAndAssetCtxs' },
      weight: 20,
      retry: true, // read-only despite POST
    });
    const receivedAt = Date.now();
    const instruments: InstrumentInfo[] = [];
    const updates: MarketUpdate[] = [];
    meta.universe.forEach((u, i) => {
      if (u.isDelisted) return;
      instruments.push(toInstrument(u));
      const ctx = ctxs[i];
      if (ctx)
        updates.push({
          symbol: u.name,
          values: parseAssetCtx(ctx, receivedAt),
          exchangeTs: null,
          receivedAt,
          connection: null,
        });
    });
    return { instruments, updates };
  }

  protected async onStart(): Promise<void> {
    const encode = (method: string) => (topics: readonly string[]) =>
      topics.map((t) => {
        const [type, coin] = t.split('|');
        return JSON.stringify({ method, subscription: { type, coin } });
      });
    const stream = new SubscriptionManager({
      name: 'hyperliquid/ws',
      url: this.#wsUrl,
      maxTopicsPerConnection: 500,
      maxConnections: 2, // 1,000 subscriptions per IP in total
      logger: this.log,
      protocol: { subscribe: encode('subscribe'), unsubscribe: encode('unsubscribe') },
      // One subscription per message; docs allow 2,000 client messages / min across all
      // connections (~33/s), so two connections at 15/s each stay below it.
      sendRate: { limit: 15, windowMs: 1_000 },
      // The server closes connections that send nothing for 60 s.
      socket: { heartbeat: { intervalMs: 30_000, message: () => '{"method":"ping"}' } },
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

  #topics(coins: string[]): string[] {
    return coins.flatMap((c) => SUBSCRIPTIONS.map((s) => `${s}|${c}`));
  }

  #onMessage(m: WsMessage): void {
    let msg: { channel?: string; data?: unknown };
    try {
      msg = JSON.parse(m.text);
    } catch {
      this.log.warn({ connection: m.connection }, 'non-JSON message');
      return;
    }
    const base = { receivedAt: m.receivedAt, connection: m.connection };
    switch (msg.channel) {
      case 'activeAssetCtx': {
        const d = msg.data as { coin?: string; ctx?: Record<string, unknown> };
        if (d?.coin && d.ctx)
          this.push({
            ...base,
            symbol: d.coin,
            values: parseAssetCtx(d.ctx, m.receivedAt),
            exchangeTs: null,
          });
        return;
      }
      case 'bbo': {
        const d = msg.data as Record<string, unknown>;
        if (typeof d?.coin !== 'string') return;
        const { ts, values } = parseBbo(d);
        this.push({ ...base, symbol: d.coin, values, exchangeTs: ts });
        return;
      }
      case 'trades': {
        const t = lastTrade(msg.data);
        if (t) this.push({ ...base, symbol: t.coin, values: { last: t.px }, exchangeTs: t.time });
        if (this.wantsTrades) for (const trade of parseTrades(msg.data)) this.pushTrade(trade);
        return;
      }
      case 'error':
        this.log.warn({ data: msg.data }, 'server reported an error');
        this.setDetail(`server error: ${String(msg.data).slice(0, 160)}`);
        return;
      default:
        return; // pong, subscriptionResponse
    }
  }
}
