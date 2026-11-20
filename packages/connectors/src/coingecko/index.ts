import type { CoinSpotStats, GlobalMarketStats, Logger } from '@mip/core';
import { RateLimiter } from '../base/rate-limiter.js';
import { RestClient } from '../base/rest-client.js';
import { parseCoinMarkets, parseGlobal } from './parse.js';

export { parseCoinMarkets, parseCoinSpot, parseGlobal } from './parse.js';

/** `/coins/markets` returns at most 250 rows per page. */
const MAX_PER_PAGE = 250;

/** The subset of `/coins/markets` rows the platform uses. */
export interface CoinMarket {
  id: string;
  symbol: string;
  name: string;
  market_cap: number | null;
  market_cap_rank: number | null;
  current_price: number | null;
  total_volume: number | null;
}

export type CoinGeckoPlan = 'public' | 'demo' | 'pro';

export interface CoinGeckoOptions {
  logger: Logger;
  apiKey?: string;
  /** Plan of the key; ignored without a key (public, keyless access). */
  plan?: 'demo' | 'pro';
  baseUrl?: string;
}

/**
 * Categories whose members are not "crypto assets" for this platform: stablecoins, wrapped /
 * bridged duplicates, liquid (re)staking derivatives, tokenised commodities such as gold.
 */
export const EXCLUDED_CATEGORIES = [
  'stablecoins',
  'wrapped-tokens',
  'bridged-tokens',
  'liquid-staking-tokens',
  'liquid-restaking-tokens',
  'tokenized-commodities',
] as const;

/**
 * Per-minute limits. Keyless access answered HTTP 429 (Retry-After: 60) after 5 rapid calls
 * when probed on 2026-11-16; the Demo plan allows 30 calls / min.
 */
const LIMITS: Record<CoinGeckoPlan, { limit: number; windowMs: number }> = {
  public: { limit: 5, windowMs: 65_000 },
  demo: { limit: 30, windowMs: 60_000 },
  pro: { limit: 500, windowMs: 60_000 },
};

export class CoinGeckoClient {
  readonly plan: CoinGeckoPlan;
  readonly #rest: RestClient;

  constructor(options: CoinGeckoOptions) {
    this.plan = options.apiKey ? (options.plan ?? 'demo') : 'public';
    const pro = this.plan === 'pro';
    const headers: Record<string, string> = {};
    if (options.apiKey) headers[pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = options.apiKey;
    this.#rest = new RestClient({
      exchange: 'coingecko',
      baseUrl: options.baseUrl ?? (pro ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com'),
      limiter: new RateLimiter({
        name: 'coingecko',
        windows: [LIMITS[this.plan]],
        headroom: this.plan === 'public' ? 1 : 0.8,
      }),
      logger: options.logger,
      headers,
      timeoutMs: 20_000,
      maxRetries: 3,
      statusPolicy: { 429: { kind: 'rate_limited', pauseMs: 60_000 } },
    });
  }

  /** Coins ordered by market cap, 250 per page. */
  async marketsPage(page: number, category?: string): Promise<CoinMarket[]> {
    const rows = await this.#rest.get<CoinMarket[]>('/api/v3/coins/markets', {
      vs_currency: 'usd',
      order: 'market_cap_desc',
      per_page: 250,
      page,
      ...(category ? { category } : {}),
    });
    if (!Array.isArray(rows)) throw new Error('unexpected /coins/markets response');
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      name: r.name,
      market_cap: r.market_cap ?? null,
      market_cap_rank: r.market_cap_rank ?? null,
      current_price: r.current_price ?? null,
      total_volume: r.total_volume ?? null,
    }));
  }

  /**
   * Ids of the largest members of the excluded categories (first page of each, i.e. the 250
   * largest by market cap, which covers every candidate in a top-few-hundred universe).
   */
  async excludedIds(categories: readonly string[] = EXCLUDED_CATEGORIES): Promise<string[]> {
    const ids = new Set<string>();
    for (const c of categories) for (const coin of await this.marketsPage(1, c)) ids.add(coin.id);
    return [...ids];
  }

  /**
   * Spot figures for the given coins, with the 7-day sparkline and 1 h / 24 h / 7 d changes.
   * Home page data: low priority (universe builds go first) and no retries (the next poll is
   * the retry), so it never holds up the shared CoinGecko budget.
   */
  async coinsByIds(ids: readonly string[]): Promise<CoinSpotStats[]> {
    const out: CoinSpotStats[] = [];
    for (let i = 0; i < ids.length; i += MAX_PER_PAGE) {
      const chunk = ids.slice(i, i + MAX_PER_PAGE);
      const rows = await this.#rest.get<unknown>(
        '/api/v3/coins/markets',
        {
          vs_currency: 'usd',
          ids: chunk.join(','),
          order: 'market_cap_desc',
          per_page: MAX_PER_PAGE,
          page: 1,
          sparkline: true,
          price_change_percentage: '1h,24h,7d',
        },
        { priority: 'low', retry: false },
      );
      out.push(...parseCoinMarkets(rows));
    }
    return out;
  }

  /** Whole-market figures (`/global`); same priority and retry rules as `coinsByIds`. */
  async global(): Promise<GlobalMarketStats> {
    const raw = await this.#rest.get<unknown>('/api/v3/global', undefined, { priority: 'low', retry: false });
    return parseGlobal(raw);
  }

  health() {
    return this.#rest.health();
  }
}
