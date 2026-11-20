import type { ExchangeId, Logger } from '@mip/core';
import { ExchangeApiError } from '../base/errors.js';
import type { RestClient } from '../base/rest-client.js';
import { num } from '../base/symbols.js';
import { createPublicRestClient } from '../public-rest.js';

/** [price, size in base units], best level first. */
export type BookLevel = [number, number];

export interface OrderBook {
  exchange: ExchangeId;
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  /** Exchange time of the book if given, else receive time. */
  ts: number;
}

const levels = (rows: unknown, contractSize: number, pick: (r: any) => [unknown, unknown]): BookLevel[] => {
  if (!Array.isArray(rows)) return [];
  const out: BookLevel[] = [];
  for (const r of rows) {
    const [p, s] = pick(r);
    const price = num(p);
    const size = num(s);
    if (price !== undefined && size !== undefined && price > 0 && size > 0)
      out.push([price, size * contractSize]);
  }
  return out;
};

const pair = (r: any): [unknown, unknown] => [r?.[0], r?.[1]];

/**
 * Parses each exchange's REST order book (recorded 2026-11-17) into base-unit levels.
 * MEXC and Gate report sizes in contracts and are multiplied by the contract size.
 */
export function parseOrderBook(
  exchange: ExchangeId,
  symbol: string,
  body: any,
  contractSize: number,
  receivedAt: number,
): OrderBook {
  switch (exchange) {
    case 'bybit':
      return {
        exchange,
        symbol,
        bids: levels(body?.result?.b, 1, pair),
        asks: levels(body?.result?.a, 1, pair),
        ts: num(body?.result?.ts) ?? receivedAt,
      };
    case 'binance':
      return {
        exchange,
        symbol,
        bids: levels(body?.bids, 1, pair),
        asks: levels(body?.asks, 1, pair),
        ts: num(body?.E) ?? receivedAt,
      };
    case 'mexc':
      return {
        exchange,
        symbol,
        bids: levels(body?.data?.bids, contractSize, pair),
        asks: levels(body?.data?.asks, contractSize, pair),
        ts: num(body?.data?.timestamp) ?? receivedAt,
      };
    case 'hyperliquid': {
      const side = (i: number) => levels(body?.levels?.[i], 1, (r) => [r?.px, r?.sz]);
      return { exchange, symbol, bids: side(0), asks: side(1), ts: num(body?.time) ?? receivedAt };
    }
    case 'bitget':
      return {
        exchange,
        symbol,
        bids: levels(body?.data?.bids, 1, pair),
        asks: levels(body?.data?.asks, 1, pair),
        ts: num(body?.data?.ts) ?? receivedAt,
      };
    case 'bingx': {
      const d = body?.data;
      return {
        exchange,
        symbol,
        bids: levels(d?.bidsCoin ?? d?.bids, 1, pair),
        asks: levels(d?.asksCoin ?? d?.asks, 1, pair),
        ts: num(d?.T) ?? receivedAt,
      };
    }
    case 'gate':
      return {
        exchange,
        symbol,
        bids: levels(body?.bids, contractSize, (r) => [r?.p, r?.s]),
        asks: levels(body?.asks, contractSize, (r) => [r?.p, r?.s]),
        ts: body?.update_us ? Math.round(body.update_us / 1000) : receivedAt,
      };
  }
}

interface Endpoint {
  request: (symbol: string) => {
    method?: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number>;
    body?: unknown;
  };
  weight?: number;
}

/** On-demand depth requests (50 levels; Hyperliquid returns 20). Hosts and limits: PUBLIC_REST. */
const ENDPOINTS: Record<ExchangeId, Endpoint> = {
  bybit: {
    request: (s) => ({ path: '/v5/market/orderbook', query: { category: 'linear', symbol: s, limit: 50 } }),
  },
  binance: {
    request: (s) => ({ path: '/fapi/v1/depth', query: { symbol: s, limit: 50 } }),
    weight: 2,
  },
  mexc: {
    request: (s) => ({ path: `/api/v1/contract/depth/${s}`, query: { limit: 50 } }),
  },
  hyperliquid: {
    request: (s) => ({ method: 'POST', path: '/info', body: { type: 'l2Book', coin: s } }),
    weight: 2,
  },
  bitget: {
    request: (s) => ({
      path: '/api/v2/mix/market/merge-depth',
      query: { symbol: s, productType: 'USDT-FUTURES', limit: 50 },
    }),
  },
  bingx: {
    request: (s) => ({ path: '/openApi/swap/v2/quote/depth', query: { symbol: s, limit: 50 } }),
  },
  gate: {
    request: (s) => ({ path: '/api/v4/futures/usdt/order_book', query: { contract: s, limit: 50 } }),
  },
};

/** Fetches order books on demand, rate-limited per exchange and cached briefly. */
export class DepthFetcher {
  readonly #clients = new Map<ExchangeId, RestClient>();
  readonly #cache = new Map<string, { book: OrderBook; at: number }>();
  readonly #log: Logger;

  constructor(
    logger: Logger,
    private readonly cacheMs = 5_000,
    private readonly baseUrls: Partial<Record<ExchangeId, string>> = {},
    /** Longest one book may take, waiting for the rate limiter included. */
    private readonly maxWaitMs = 10_000,
  ) {
    this.#log = logger.child({ component: 'depth' });
  }

  /**
   * Fetches one order book. Fails at once while the exchange's REST access is paused (ban or
   * rate limit) and after `maxWaitMs` otherwise: callers report the book as missing instead of
   * waiting. Waiting for a ban used to hold up every scanner until the ban ended.
   */
  async fetch(exchange: ExchangeId, symbol: string, contractSize: number): Promise<OrderBook> {
    const key = `${exchange}:${symbol}`;
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.book;
    const ep = ENDPOINTS[exchange];
    const req = ep.request(symbol);
    const client = this.#client(exchange);
    const paused = client.health().pausedUntil;
    if (paused)
      throw new ExchangeApiError(
        'aborted',
        `${exchange} REST requests paused until ${new Date(paused).toISOString()} (rate limit or ban)`,
        { exchange },
      );
    const body = await client.request({
      method: req.method ?? 'GET',
      path: req.path,
      ...(req.query ? { query: req.query } : {}),
      ...(req.body ? { body: req.body } : {}),
      weight: ep.weight ?? 1,
      priority: 'low',
      retry: true,
      signal: AbortSignal.timeout(this.maxWaitMs),
    });
    const book = parseOrderBook(exchange, symbol, body, contractSize, Date.now());
    this.#cache.set(key, { book, at: Date.now() });
    return book;
  }

  /** REST pause per exchange (ban / rate limit), for health reporting. */
  pausedUntil(exchange: ExchangeId): number | null {
    return this.#clients.get(exchange)?.health().pausedUntil ?? null;
  }

  #client(exchange: ExchangeId): RestClient {
    let c = this.#clients.get(exchange);
    if (!c) {
      c = createPublicRestClient(exchange, this.#log, this.baseUrls[exchange]);
      this.#clients.set(exchange, c);
    }
    return c;
  }
}
