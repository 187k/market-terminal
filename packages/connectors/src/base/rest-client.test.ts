import { afterEach, describe, expect, it } from 'vitest';
import { json, silentLogger, startHttpServer, type TestHttpServer } from '../test-support/servers.js';
import { ExchangeApiError } from './errors.js';
import { RateLimiter } from './rate-limiter.js';
import { parseRetryAfter, RestClient, type RestClientOptions } from './rest-client.js';

let server: TestHttpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function client(baseUrl: string, extra: Partial<RestClientOptions> = {}) {
  const limiter = new RateLimiter({ name: 'test', windows: [{ limit: 100, windowMs: 1_000 }], headroom: 1 });
  const rest = new RestClient({
    exchange: 'test',
    baseUrl,
    limiter,
    logger: silentLogger,
    backoff: { baseMs: 10, maxMs: 20, jitter: 0 },
    ...extra,
  });
  return { rest, limiter };
}

async function expectApiError(p: Promise<unknown>, kind: string): Promise<ExchangeApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ExchangeApiError);
    expect((err as ExchangeApiError).kind).toBe(kind);
    return err as ExchangeApiError;
  }
  throw new Error('expected request to fail');
}

describe('RestClient', () => {
  it('returns parsed JSON and sends query parameters', async () => {
    server = await startHttpServer((req, res) => json(res, 200, { url: req.url }));
    const { rest } = client(server.baseUrl);
    const body = await rest.get<{ url: string }>('/v5/market/tickers', {
      category: 'linear',
      symbol: 'BTCUSDT',
      skip: undefined,
    });
    expect(body.url).toBe('/v5/market/tickers?category=linear&symbol=BTCUSDT');
    expect(rest.health()).toMatchObject({ requests: 1, errors: 0 });
  });

  it('retries 5xx responses with backoff, then succeeds', async () => {
    server = await startHttpServer((_req, res, hit) =>
      hit < 3 ? json(res, 502, { e: 'bad gateway' }) : json(res, 200, { ok: true }),
    );
    const { rest } = client(server.baseUrl);
    await expect(rest.get('/x')).resolves.toEqual({ ok: true });
    expect(server.hits).toHaveLength(3);
    expect(rest.health().errors).toBe(2);
  });

  it('honours Retry-After on 429 by pausing the limiter before retrying', async () => {
    server = await startHttpServer((_req, res, hit) =>
      hit === 1 ? json(res, 429, { e: 'slow down' }, { 'retry-after': '0.2' }) : json(res, 200, { ok: true }),
    );
    const { rest } = client(server.baseUrl);
    const started = Date.now();
    await expect(rest.get('/x')).resolves.toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(rest.health().rateLimited).toBe(1);
  });

  it('does not retry client errors', async () => {
    server = await startHttpServer((_req, res) => json(res, 400, { msg: 'bad symbol' }));
    const { rest } = client(server.baseUrl);
    const err = await expectApiError(rest.get('/x'), 'client');
    expect(err.details.status).toBe(400);
    expect(server.hits).toHaveLength(1);
  });

  it('does not retry non-GET requests by default', async () => {
    server = await startHttpServer((_req, res) => json(res, 500, {}));
    const { rest } = client(server.baseUrl);
    await expectApiError(rest.request({ method: 'POST', path: '/x', body: { a: 1 } }), 'server');
    expect(server.hits).toHaveLength(1);
  });

  it('treats a ban as fatal and pauses all requests', async () => {
    server = await startHttpServer((_req, res) => json(res, 418, { msg: 'banned' }));
    const { rest, limiter } = client(server.baseUrl);
    await expectApiError(rest.get('/x'), 'banned');
    expect(server.hits).toHaveLength(1);
    expect(limiter.pausedUntil).toBeGreaterThan(Date.now() + 60_000);
  });

  it('supports exchange-specific status policies (Bybit 403 = IP ban)', async () => {
    server = await startHttpServer((_req, res) => json(res, 403, { msg: 'access too frequent' }));
    const { rest, limiter } = client(server.baseUrl, {
      statusPolicy: { 403: { kind: 'banned', pauseMs: 600_000 } },
    });
    await expectApiError(rest.get('/x'), 'banned');
    expect(limiter.pausedUntil).toBeGreaterThan(Date.now() + 590_000);
  });

  it('classifies timeouts', async () => {
    server = await startHttpServer((_req, res) => setTimeout(() => json(res, 200, {}), 500));
    const { rest } = client(server.baseUrl, { timeoutMs: 100, maxRetries: 0 });
    await expectApiError(rest.get('/slow'), 'timeout');
  });

  it('classifies connection failures as network errors', async () => {
    const { rest } = client('http://127.0.0.1:1', { maxRetries: 0 });
    await expectApiError(rest.get('/x'), 'network');
  });

  it('detects errors reported inside HTTP 200 bodies', async () => {
    server = await startHttpServer((_req, res) => json(res, 200, { retCode: 10001, retMsg: 'params error' }));
    const { rest } = client(server.baseUrl, {
      checkBody: (b) => {
        const body = b as { retCode: number; retMsg: string };
        return body.retCode === 0 ? null : { code: body.retCode, message: body.retMsg };
      },
    });
    const err = await expectApiError(rest.get('/x'), 'exchange');
    expect(err.details.code).toBe(10001);
    expect(server.hits).toHaveLength(1);
  });

  it('rejects malformed JSON as a decode error', async () => {
    server = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    });
    const { rest } = client(server.baseUrl);
    await expectApiError(rest.get('/x'), 'decode');
  });

  it('lets beforeSend add authentication headers', async () => {
    server = await startHttpServer((req, res) => json(res, 200, { key: req.headers['x-api-key'] }));
    const { rest } = client(server.baseUrl, {
      beforeSend: (req) => ({ ...req, headers: { ...req.headers, 'x-api-key': 'k1' } }),
    });
    await expect(rest.get('/x')).resolves.toEqual({ key: 'k1' });
  });

  it('stops when the caller aborts', async () => {
    server = await startHttpServer((_req, res) => setTimeout(() => json(res, 200, {}), 500));
    const { rest } = client(server.baseUrl);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expectApiError(rest.get('/x', undefined, { signal: ac.signal }), 'aborted');
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('2', 0)).toBe(2_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });
});
