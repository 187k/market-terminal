import type { ExchangeId, Logger } from '@mip/core';
import { sharedRateLimiter, type WindowLimit } from './base/rate-limiter.js';
import { RestClient } from './base/rest-client.js';

interface PublicRestConfig {
  baseUrl: string;
  /** IP limit of the public market-data endpoints; the limiter keeps 20 % headroom. */
  limit: WindowLimit;
  headers?: Record<string, string>;
}

/**
 * Public market-data REST hosts used for on-demand requests (order books, candles). The limiter
 * names are the connectors' (`<exchange>/rest`), so every request a process sends to one
 * exchange counts against one budget and honours one pause (ban or rate limit).
 */
export const PUBLIC_REST: Readonly<Record<ExchangeId, PublicRestConfig>> = {
  bybit: { baseUrl: 'https://api.bybit.com', limit: { limit: 600, windowMs: 5_000 } },
  binance: { baseUrl: 'https://fapi.binance.com', limit: { limit: 2_400, windowMs: 60_000 } },
  mexc: { baseUrl: 'https://api.mexc.com', limit: { limit: 10, windowMs: 2_000 } },
  hyperliquid: { baseUrl: 'https://api.hyperliquid.xyz', limit: { limit: 1_200, windowMs: 60_000 } },
  bitget: { baseUrl: 'https://api.bitget.com', limit: { limit: 20, windowMs: 1_000 } },
  bingx: { baseUrl: 'https://open-api.bingx.com', limit: { limit: 500, windowMs: 10_000 } },
  gate: {
    baseUrl: 'https://api.gateio.ws',
    limit: { limit: 200, windowMs: 10_000 },
    // Fractional contract sizes instead of rounded integers.
    headers: { 'X-Gate-Size-Decimal': '1' },
  },
};

/** A REST client for one exchange's public endpoints: short timeout, one retry. */
export function createPublicRestClient(exchange: ExchangeId, logger: Logger, baseUrl?: string): RestClient {
  const cfg = PUBLIC_REST[exchange];
  return new RestClient({
    exchange,
    baseUrl: baseUrl ?? cfg.baseUrl,
    limiter: sharedRateLimiter({ name: `${exchange}/rest`, windows: [cfg.limit] }),
    logger,
    ...(cfg.headers ? { headers: cfg.headers } : {}),
    timeoutMs: 5_000,
    maxRetries: 1,
    // Bybit answers an IP ban with 403 (10 minutes).
    statusPolicy: exchange === 'bybit' ? { 403: { kind: 'banned', pauseMs: 10 * 60_000 } } : {},
  });
}
