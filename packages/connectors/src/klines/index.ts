import {
  CANDLE_INTERVAL_MS,
  type Candle,
  type CandleInterval,
  type ExchangeId,
  type Logger,
} from '@mip/core';
import { ExchangeApiError } from '../base/errors.js';
import type { RestClient } from '../base/rest-client.js';
import { num } from '../base/symbols.js';
import { createPublicRestClient } from '../public-rest.js';

/** Largest page requested at once; every exchange allows at least this many candles. */
export const MAX_KLINES_PER_REQUEST = 500;

export interface KlineQuery {
  /** Number of candles wanted (capped at MAX_KLINES_PER_REQUEST). */
  limit: number;
  /** Only candles that open before this time (Unix ms); the newest candles when omitted. */
  before?: number;
  /** Base units per contract, for exchanges that report volume in contracts (MEXC, Gate). */
  contractSize: number;
}

interface RequestSpec {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
}

interface Window {
  limit: number;
  /** Last allowed open time (inclusive), or undefined for "up to now". */
  end: number | undefined;
  /** First open time a time-range request should cover (for exchanges that need a range). */
  start: number;
  /** Seconds-based end for range requests. */
  endOrNow: number;
}

interface KlineEndpoint {
  intervals: Readonly<Record<CandleInterval, string>>;
  request(symbol: string, interval: string, w: Window): RequestSpec;
  weight?(limit: number): number;
  /** Rows as the exchange sent them, in any order; validated and sorted afterwards. */
  parse(body: any, contractSize: number): (Candle | null)[];
}

const SAME = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
} as const satisfies Record<CandleInterval, string>;

const sec = (ms: number) => Math.floor(ms / 1000);
/** A seconds timestamp from a payload, in ms. */
const msFromSec = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : n * 1000;
};

const candle = (
  openTime: unknown,
  o: unknown,
  h: unknown,
  l: unknown,
  c: unknown,
  volume: unknown,
  turnover: unknown,
  volumeFactor = 1,
): Candle | null => {
  const t = num(openTime);
  const open = num(o);
  const high = num(h);
  const low = num(l);
  const close = num(c);
  const v = num(volume);
  if (t === undefined || open === undefined || high === undefined || low === undefined) return null;
  if (close === undefined || v === undefined) return null;
  const q = turnover === undefined ? undefined : num(turnover);
  return { openTime: t, open, high, low, close, volume: v * volumeFactor, turnover: q ?? null };
};

const rows = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/**
 * Public candle endpoints (documented; payloads recorded 2026-11-20 in `fixtures/`). Volume is
 * converted to base units: MEXC and Gate report contracts. BingX's v3 `volume` unit is not
 * stated in its docs; it matches base units in the recorded data [?].
 */
const ENDPOINTS: Readonly<Record<ExchangeId, KlineEndpoint>> = {
  bybit: {
    intervals: {
      '1m': '1',
      '5m': '5',
      '15m': '15',
      '30m': '30',
      '1h': '60',
      '4h': '240',
      '1d': 'D',
      '1w': 'W',
    },
    request: (symbol, interval, w) => ({
      path: '/v5/market/kline',
      query: {
        category: 'linear',
        symbol,
        interval,
        limit: w.limit,
        ...(w.end !== undefined ? { end: w.end } : {}),
      },
    }),
    // [start, open, high, low, close, volume (base), turnover (quote)], newest first
    parse: (b) =>
      rows(b?.result?.list).map((r) => candle(r?.[0], r?.[1], r?.[2], r?.[3], r?.[4], r?.[5], r?.[6])),
  },
  binance: {
    intervals: SAME,
    request: (symbol, interval, w) => ({
      path: '/fapi/v1/klines',
      query: { symbol, interval, limit: w.limit, ...(w.end !== undefined ? { endTime: w.end } : {}) },
    }),
    // Documented weight by limit: [1,100) 1, [100,500) 2, [500,1000] 5, above 10.
    weight: (limit) => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10),
    // [openTime, open, high, low, close, volume (base), closeTime, quoteVolume, ...], oldest first
    parse: (b) => rows(b).map((r) => candle(r?.[0], r?.[1], r?.[2], r?.[3], r?.[4], r?.[5], r?.[7])),
  },
  mexc: {
    intervals: {
      '1m': 'Min1',
      '5m': 'Min5',
      '15m': 'Min15',
      '30m': 'Min30',
      '1h': 'Min60',
      '4h': 'Hour4',
      '1d': 'Day1',
      '1w': 'Week1',
    },
    // Takes a time range in seconds rather than a count.
    request: (symbol, interval, w) => ({
      path: `/api/v1/contract/kline/${symbol}`,
      query: { interval, start: sec(w.start), end: sec(w.endOrNow) },
    }),
    // Column arrays; time in seconds, vol in contracts, amount in quote currency.
    parse: (b, contractSize) => {
      const d = b?.data;
      return rows(d?.time).map((t, i) =>
        candle(
          msFromSec(t),
          d?.open?.[i],
          d?.high?.[i],
          d?.low?.[i],
          d?.close?.[i],
          d?.vol?.[i],
          d?.amount?.[i],
          contractSize,
        ),
      );
    },
  },
  hyperliquid: {
    intervals: SAME,
    request: (symbol, interval, w) => ({
      method: 'POST',
      path: '/info',
      body: {
        type: 'candleSnapshot',
        req: { coin: symbol, interval, startTime: w.start, endTime: w.endOrNow },
      },
    }),
    // Info requests weigh 20, plus 1 per 60 candles returned (Hyperliquid rate-limit docs).
    weight: (limit) => 20 + Math.ceil(limit / 60),
    // [{t, o, h, l, c, v (base)}], oldest first; no turnover.
    parse: (b) => rows(b).map((r) => candle(r?.t, r?.o, r?.h, r?.l, r?.c, r?.v, undefined)),
  },
  bitget: {
    // The "utc" variants start days and weeks at 00:00 UTC; plain 1D / 1W use UTC+8.
    intervals: { ...SAME, '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc' },
    request: (symbol, interval, w) => ({
      path: '/api/v2/mix/market/candles',
      query: {
        symbol,
        productType: 'USDT-FUTURES',
        granularity: interval,
        limit: w.limit,
        ...(w.end !== undefined ? { endTime: w.end } : {}),
      },
    }),
    // [ts, open, high, low, close, baseVolume, quoteVolume], oldest first
    parse: (b) => rows(b?.data).map((r) => candle(r?.[0], r?.[1], r?.[2], r?.[3], r?.[4], r?.[5], r?.[6])),
  },
  bingx: {
    intervals: SAME,
    request: (symbol, interval, w) => ({
      path: '/openApi/swap/v3/quote/klines',
      query: { symbol, interval, limit: w.limit, ...(w.end !== undefined ? { endTime: w.end } : {}) },
    }),
    // [{open, close, high, low, volume, time}], newest first; no turnover.
    parse: (b) =>
      rows(b?.data).map((r) => candle(r?.time, r?.open, r?.high, r?.low, r?.close, r?.volume, undefined)),
  },
  gate: {
    intervals: { ...SAME, '1w': '7d' },
    // `limit` cannot be combined with `from` / `to` (Gate docs), so older pages use a range.
    request: (symbol, interval, w) => ({
      path: '/api/v4/futures/usdt/candlesticks',
      query: {
        contract: symbol,
        interval,
        ...(w.end === undefined ? { limit: w.limit } : { from: sec(w.start), to: sec(w.end) }),
      },
    }),
    // [{t (s), o, h, l, c, v (contracts), sum (quote)}], oldest first
    parse: (b, contractSize) =>
      rows(b).map((r) => candle(msFromSec(r?.t), r?.o, r?.h, r?.l, r?.c, r?.v, r?.sum, contractSize)),
  },
};

/** Caveats about an exchange's candles, shown under the terminal chart. */
export const KLINE_NOTES: Readonly<Partial<Record<ExchangeId, readonly string[]>>> = {
  bingx: [
    'BingX does not document the unit of candle volume; it is shown as base units because it matches them in recorded data.',
  ],
};

/** A candle that could be real: positive prices, high ≥ low, non-negative volume. */
const plausible = (c: Candle | null): c is Candle =>
  c !== null &&
  c.openTime > 0 &&
  c.open > 0 &&
  c.close > 0 &&
  c.low > 0 &&
  c.high >= c.low &&
  c.volume >= 0 &&
  (c.turnover === null || c.turnover >= 0);

/**
 * Parses one exchange's kline response into candles, oldest first: implausible rows dropped,
 * duplicates removed, only candles opening before `before`, at most `limit` (the newest).
 */
export function parseKlines(
  exchange: ExchangeId,
  body: unknown,
  q: Pick<KlineQuery, 'limit' | 'before' | 'contractSize'>,
): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of ENDPOINTS[exchange].parse(body, q.contractSize))
    if (plausible(c) && (q.before === undefined || c.openTime < q.before)) byTime.set(c.openTime, c);
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime).slice(-q.limit);
}

/** The exchange's own name for a candle interval (e.g. Bybit "60", MEXC "Min60"). */
export const klineInterval = (exchange: ExchangeId, interval: CandleInterval): string =>
  ENDPOINTS[exchange].intervals[interval];

/** Builds the request for one page of candles (exported for tests). */
export function klineRequest(
  exchange: ExchangeId,
  symbol: string,
  interval: CandleInterval,
  q: Pick<KlineQuery, 'limit' | 'before'>,
  now: number,
): RequestSpec & { weight: number } {
  const ep = ENDPOINTS[exchange];
  const limit = Math.max(1, Math.min(Math.floor(q.limit), MAX_KLINES_PER_REQUEST));
  const end = q.before === undefined ? undefined : q.before - 1;
  const endOrNow = end ?? now;
  // One extra period so a range request still covers `limit` candles when `end` is mid-candle.
  const start = endOrNow - (limit + 1) * CANDLE_INTERVAL_MS[interval];
  const spec = ep.request(symbol, ep.intervals[interval], { limit, end, start, endOrNow });
  return { ...spec, weight: ep.weight?.(limit) ?? 1 };
}

/**
 * Fetches candles on demand (the dashboard terminal), rate-limited per exchange with the same
 * shared limiters as the connectors and the order-book fetcher. Fails at once while the
 * exchange's REST access is paused (ban or rate limit), never waiting for a ban to end.
 */
export class KlineFetcher {
  readonly #clients = new Map<ExchangeId, RestClient>();
  readonly #log: Logger;

  constructor(
    logger: Logger,
    private readonly baseUrls: Partial<Record<ExchangeId, string>> = {},
    /** Longest one request may take, waiting for the rate limiter included. */
    private readonly maxWaitMs = 10_000,
  ) {
    this.#log = logger.child({ component: 'klines' });
  }

  async fetch(
    exchange: ExchangeId,
    symbol: string,
    interval: CandleInterval,
    q: KlineQuery,
  ): Promise<Candle[]> {
    const client = this.#client(exchange);
    const paused = client.health().pausedUntil;
    if (paused)
      throw new ExchangeApiError(
        'aborted',
        `${exchange} REST requests paused until ${new Date(paused).toISOString()} (rate limit or ban)`,
        { exchange },
      );
    const req = klineRequest(exchange, symbol, interval, q, Date.now());
    const body = await client.request({
      method: req.method ?? 'GET',
      path: req.path,
      ...(req.query ? { query: req.query } : {}),
      ...(req.body ? { body: req.body } : {}),
      weight: req.weight,
      priority: 'low',
      retry: true,
      signal: AbortSignal.timeout(this.maxWaitMs),
    });
    return parseKlines(exchange, body, {
      limit: Math.min(q.limit, MAX_KLINES_PER_REQUEST),
      contractSize: q.contractSize,
      ...(q.before !== undefined ? { before: q.before } : {}),
    });
  }

  /** REST pause per exchange (ban / rate limit), for health reporting and ban sharing. */
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
