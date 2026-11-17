import {
  backoffDelay,
  sleep,
  systemNow,
  type BackoffOptions,
  type Logger,
  type Now,
  type RestHealth,
} from '@mip/core';
import { ExchangeApiError, type ExchangeErrorKind } from './errors.js';
import type { Priority, RateLimiter } from './rate-limiter.js';

export interface StatusPolicy {
  kind: ExchangeErrorKind;
  /** Hold all requests to this exchange for this long (overridden by Retry-After when present). */
  pauseMs?: number;
}

/** Defaults; each exchange can override (e.g. Bybit uses 403 for a 10-minute IP ban). */
export const DEFAULT_STATUS_POLICY: Readonly<Record<number, StatusPolicy>> = {
  429: { kind: 'rate_limited', pauseMs: 5_000 },
  418: { kind: 'banned', pauseMs: 120_000 },
};

export type QueryValue = string | number | boolean | undefined | null;

export interface RestRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Rate-limit weight of this endpoint (default 1). */
  weight?: number;
  priority?: Priority;
  signal?: AbortSignal;
  /** Retry on timeouts, 5xx and 429. Defaults to true for GET only. */
  retry?: boolean;
}

/** Final request as it will be sent; `beforeSend` may add auth headers / signatures. */
export interface PreparedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface BusinessError {
  code: string | number;
  message: string;
  kind?: ExchangeErrorKind;
}

export interface RestClientOptions {
  exchange: string;
  baseUrl: string;
  limiter: RateLimiter;
  logger: Logger;
  timeoutMs?: number;
  maxRetries?: number;
  backoff?: BackoffOptions;
  headers?: Record<string, string>;
  statusPolicy?: Record<number, StatusPolicy>;
  /** Detects errors reported inside an HTTP 200 body (e.g. Bybit `retCode != 0`). */
  checkBody?: (body: unknown) => BusinessError | null;
  beforeSend?: (req: PreparedRequest) => PreparedRequest | Promise<PreparedRequest>;
  fetch?: typeof fetch;
  now?: Now;
}

/** Rate-limited HTTP client with timeouts, bounded retries and error classification. */
export class RestClient {
  readonly exchange: string;
  readonly #opts: Required<
    Pick<RestClientOptions, 'timeoutMs' | 'maxRetries' | 'backoff' | 'headers' | 'statusPolicy'>
  > &
    RestClientOptions;
  readonly #fetch: typeof fetch;
  readonly #now: Now;
  readonly #log: Logger;
  #requests = 0;
  #errors = 0;
  #rateLimited = 0;
  #lastError: string | null = null;
  #lastErrorAt: number | null = null;
  #avgLatency: number | null = null;

  constructor(options: RestClientOptions) {
    this.exchange = options.exchange;
    this.#opts = {
      timeoutMs: 10_000,
      maxRetries: 2,
      backoff: { baseMs: 500, maxMs: 8_000, jitter: 0.5 },
      ...options,
      headers: { accept: 'application/json', ...options.headers },
      statusPolicy: { ...DEFAULT_STATUS_POLICY, ...options.statusPolicy },
    };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? systemNow;
    this.#log = options.logger.child({ component: 'rest', exchange: options.exchange });
  }

  async get<T = unknown>(
    path: string,
    query?: Record<string, QueryValue>,
    extra: Omit<RestRequest, 'path' | 'query' | 'method'> = {},
  ): Promise<T> {
    return this.request<T>({ ...extra, method: 'GET', path, ...(query ? { query } : {}) });
  }

  async request<T = unknown>(req: RestRequest): Promise<T> {
    const method = req.method ?? 'GET';
    const retry = req.retry ?? method === 'GET';
    const maxAttempts = retry ? this.#opts.maxRetries + 1 : 1;
    let lastError: ExchangeApiError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.#opts.limiter.acquire(req.weight ?? 1, {
          ...(req.priority ? { priority: req.priority } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (err) {
        throw new ExchangeApiError('aborted', 'request aborted while waiting for rate limit', {
          exchange: this.exchange,
          method,
          path: req.path,
          cause: err,
        });
      }

      try {
        return await this.#send<T>(method, req);
      } catch (err) {
        const error =
          err instanceof ExchangeApiError
            ? err
            : new ExchangeApiError('network', String(err), {
                exchange: this.exchange,
                path: req.path,
                cause: err,
              });
        lastError = error;
        this.#recordError(error);
        const last = attempt === maxAttempts - 1;
        if (!error.retryable || last) break;
        const delay =
          error.kind === 'rate_limited'
            ? 0 /* the limiter is paused */
            : backoffDelay(attempt, this.#opts.backoff);
        this.#log.warn(
          { path: req.path, kind: error.kind, attempt: attempt + 1, delay },
          'request failed, retrying',
        );
        if (delay > 0) await sleep(delay, req.signal).catch(() => undefined);
        if (req.signal?.aborted) break;
      }
    }
    throw (
      lastError ??
      new ExchangeApiError('network', 'request failed', { exchange: this.exchange, path: req.path })
    );
  }

  health(): RestHealth {
    return {
      requests: this.#requests,
      errors: this.#errors,
      rateLimited: this.#rateLimited,
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt,
      pausedUntil: this.#opts.limiter.pausedUntil,
      avgLatencyMs: this.#avgLatency === null ? null : Math.round(this.#avgLatency),
    };
  }

  async #send<T>(method: string, req: RestRequest): Promise<T> {
    const url = new URL(req.path, this.#opts.baseUrl);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { ...this.#opts.headers, ...req.headers };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      headers['content-type'] ??= 'application/json';
    }
    let prepared: PreparedRequest = { method, url, headers, body };
    if (this.#opts.beforeSend) prepared = await this.#opts.beforeSend(prepared);

    const timeout = AbortSignal.timeout(this.#opts.timeoutMs);
    const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
    const details = { exchange: this.exchange, method, path: url.pathname };
    const started = this.#now();
    this.#requests++;

    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
        signal,
      });
      text = await res.text();
    } catch (err) {
      if (req.signal?.aborted)
        throw new ExchangeApiError('aborted', 'request aborted', { ...details, cause: err });
      if (timeout.aborted) {
        throw new ExchangeApiError('timeout', `timed out after ${this.#opts.timeoutMs} ms`, {
          ...details,
          cause: err,
        });
      }
      const cause = (err as { cause?: { code?: string } }).cause;
      throw new ExchangeApiError('network', `network error: ${cause?.code ?? (err as Error).message}`, {
        ...details,
        cause: err,
      });
    } finally {
      const latency = this.#now() - started;
      this.#avgLatency = this.#avgLatency === null ? latency : this.#avgLatency * 0.8 + latency * 0.2;
    }

    if (!res.ok) throw this.#statusError(res, text, details);

    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new ExchangeApiError('decode', `invalid JSON (${text.slice(0, 80)})`, {
          ...details,
          status: res.status,
          cause: err,
        });
      }
    }
    const business = this.#opts.checkBody?.(parsed);
    if (business) {
      const kind = business.kind ?? 'exchange';
      if (kind === 'rate_limited') this.#opts.limiter.pause(this.#opts.statusPolicy[429]?.pauseMs ?? 5_000);
      throw new ExchangeApiError(kind, `exchange error ${business.code}: ${business.message}`, {
        ...details,
        status: res.status,
        code: business.code,
      });
    }
    return parsed as T;
  }

  #statusError(
    res: Response,
    text: string,
    details: { exchange: string; method: string; path: string },
  ): ExchangeApiError {
    const policy = this.#opts.statusPolicy[res.status];
    const kind: ExchangeErrorKind = policy?.kind ?? (res.status >= 500 ? 'server' : 'client');
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.#now());
    const pauseMs = retryAfterMs ?? policy?.pauseMs;
    if (pauseMs !== undefined && (kind === 'rate_limited' || kind === 'banned')) {
      this.#opts.limiter.pause(pauseMs);
      this.#log.error({ status: res.status, kind, pauseMs }, 'exchange is throttling us; pausing requests');
    }
    return new ExchangeApiError(kind, `HTTP ${res.status}: ${text.slice(0, 200)}`, {
      ...details,
      status: res.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  #recordError(error: ExchangeApiError): void {
    if (error.kind === 'aborted') return;
    this.#errors++;
    if (error.kind === 'rate_limited' || error.kind === 'banned') this.#rateLimited++;
    this.#lastError = error.message;
    this.#lastErrorAt = this.#now();
  }
}

/** Retry-After is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
