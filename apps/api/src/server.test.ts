import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  parseScannerSettings,
  WS_CLOSE_UNAUTHORIZED,
  type RealtimeServerMessage,
  type SystemStatus,
} from '@mip/core';
import type { AssetSource } from './assets.js';
import { LoginThrottle, SESSION_COOKIE } from './auth.js';
import { buildServer } from './server.js';
import type { MarketSource } from './markets.js';
import type { ScannerSource } from './scanners.js';
import { MemorySessionStore } from './sessions.js';
import type { StatusSource } from './status.js';

const STATUS: SystemStatus = {
  serverTime: 1,
  processes: [{ name: 'collector', alive: true, pid: 10, version: '0.1.0', startedAt: 1, lastSeenAt: 2 }],
  exchanges: [],
  exchangesUpdatedAt: null,
};

let app: FastifyInstance;
let health = { db: true, redis: true };

beforeEach(async () => {
  health = { db: true, redis: true };
  const status: StatusSource = {
    systemStatus: async () => STATUS,
    connectionEvents: async (limit) => [
      {
        id: '1',
        at: new Date(0).toISOString(),
        exchange: 'bybit',
        connection: `limit=${limit}`,
        state: 'open',
        reason: null,
      },
    ],
    health: async () => health,
  };
  const markets: MarketSource = {
    markets: async (exchange) => ({ exchange, ts: 1, stale: false, rows: [], capabilities: null }),
    universe: async () => null,
  };
  saved = [];
  const scanners: ScannerSource = {
    scanners: async () => ({ scanners: [], updatedAt: null }),
    signals: async (q) => [{ id: `q:${q.scanner ?? '*'}:${q.status ?? '*'}:${q.limit}` } as never],
    liveSignals: async () => ({ active: [], recent: [], updatedAt: null }),
    getSettings: async (id) => ({
      scanner: id,
      enabled: true,
      settings: {},
      defaults: {},
      schema: {},
      updatedAt: null,
    }),
    putSettings: async (id, body) => {
      const parsed = parseScannerSettings(id, body.settings);
      if (!parsed.ok) return { ok: false, problems: parsed.problems };
      saved.push(parsed.settings);
      return {
        ok: true,
        value: {
          scanner: id,
          enabled: true,
          settings: parsed.settings,
          defaults: {},
          schema: {},
          updatedAt: 1,
        },
      };
    },
  };
  const assets: AssetSource = {
    asset: async (code) => ({ asset: code }) as never,
  };
  app = await buildServer({
    logger: createLogger({ service: 'test', level: 'silent' }),
    auth: { username: 'admin', password: 'correct horse', ttlSeconds: 3600, cookieSecure: false },
    cookieSecret: 'x'.repeat(32),
    sessions: new MemorySessionStore(),
    status,
    markets,
    scanners,
    assets,
  });
});

let saved: Record<string, unknown>[] = [];

afterEach(async () => {
  await app.close();
});

async function login(password = 'correct horse') {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password } });
}

function sessionCookie(res: Awaited<ReturnType<typeof login>>): string {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  if (!c) throw new Error('no session cookie');
  return `${c.name}=${c.value}`;
}

describe('API', () => {
  it('serves a public health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: true, redis: true });
  });

  it('reports 503 when a dependency is down', async () => {
    health = { db: false, redis: true };
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: false });
  });

  it('serves market data per exchange and rejects unknown exchanges', async () => {
    const cookie = sessionCookie(await login());
    const ok = await app.inject({ method: 'GET', url: '/api/markets/bybit', headers: { cookie } });
    expect(ok.json()).toMatchObject({ exchange: 'bybit', rows: [] });
    const bad = await app.inject({ method: 'GET', url: '/api/markets/kraken', headers: { cookie } });
    expect(bad.statusCode).toBe(400);
    const uni = await app.inject({ method: 'GET', url: '/api/universe', headers: { cookie } });
    expect(uni.json()).toEqual({ universe: null });
  });

  it('serves signals with validated filters', async () => {
    const cookie = sessionCookie(await login());
    const ok = await app.inject({
      method: 'GET',
      url: '/api/signals?scanner=fair-price&status=active&limit=9999',
      headers: { cookie },
    });
    expect(ok.json()).toEqual({ signals: [{ id: 'q:fair-price:active:500' }] });
    expect(
      (await app.inject({ method: 'GET', url: '/api/signals?scanner=nope', headers: { cookie } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/signals?status=open', headers: { cookie } })).statusCode,
    ).toBe(400);
    for (const q of ['asset=BTC', 'exchange=gate'])
      expect(
        (await app.inject({ method: 'GET', url: `/api/signals?${q}`, headers: { cookie } })).statusCode,
      ).toBe(200);
    for (const q of ['asset=%3Cscript%3E', 'exchange=kraken'])
      expect(
        (await app.inject({ method: 'GET', url: `/api/signals?${q}`, headers: { cookie } })).statusCode,
      ).toBe(400);
    const live = await app.inject({ method: 'GET', url: '/api/signals/live', headers: { cookie } });
    expect(live.json()).toEqual({ active: [], recent: [], updatedAt: null });
  });

  it('serves coin details for valid asset codes only', async () => {
    const cookie = sessionCookie(await login());
    const ok = await app.inject({ method: 'GET', url: '/api/assets/1000PEPE', headers: { cookie } });
    expect(ok.json()).toEqual({ asset: '1000PEPE' });
    const bad = await app.inject({ method: 'GET', url: '/api/assets/a%20b', headers: { cookie } });
    expect(bad.statusCode).toBe(400);
  });

  it('validates scanner settings before saving them', async () => {
    const cookie = sessionCookie(await login());
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/scanners/fair-price/settings',
      headers: { cookie },
      payload: { settings: { minDeviationPct: -1, exchanges: ['kraken'] } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().problems).toHaveLength(2);
    expect(saved).toHaveLength(0);
    const good = await app.inject({
      method: 'PUT',
      url: '/api/scanners/fair-price/settings',
      headers: { cookie },
      payload: { settings: { minDeviationPct: 0.8 } },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().settings).toMatchObject({ minDeviationPct: 0.8, requireExecutable: true });
    expect(
      (await app.inject({ method: 'GET', url: '/api/scanners/nope/settings', headers: { cookie } }))
        .statusCode,
    ).toBe(404);
  });

  it('protects system routes', async () => {
    for (const url of [
      '/api/system/status',
      '/api/system/events',
      '/api/auth/me',
      '/api/markets/bybit',
      '/api/universe',
      '/api/signals/live',
      '/api/assets/BTC',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('rejects wrong credentials', async () => {
    const res = await login('wrong');
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  it('validates the login body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin' } });
    expect(res.statusCode).toBe(400);
  });

  it('logs in with an httpOnly signed cookie, serves protected data, and logs out', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: 'admin' });
    const raw = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(raw.httpOnly).toBe(true);
    expect(raw.sameSite).toBe('Lax');
    const cookie = sessionCookie(res);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toEqual({ username: 'admin' });

    const status = await app.inject({ method: 'GET', url: '/api/system/status', headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual(STATUS);

    const events = await app.inject({
      method: 'GET',
      url: '/api/system/events?limit=9999',
      headers: { cookie },
    });
    expect(events.json()[0].connection).toBe('limit=500');

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('ignores tampered session cookies', async () => {
    const res = await login();
    const cookie = sessionCookie(res).replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('throttles repeated failed logins', async () => {
    for (let i = 0; i < 10; i++) expect((await login('nope')).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(429);
  });

  it('returns JSON 404s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});

/** Opens `/ws` in-process and records every message and the close code. */
async function openWs(headers: Record<string, string>) {
  await app.ready();
  const messages: RealtimeServerMessage[] = [];
  let closed: number | null = null;
  // Listeners go on before the socket opens: the server greets immediately.
  const ws: WebSocket = await app.injectWS(
    '/ws',
    { headers },
    {
      onInit(socket) {
        socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as RealtimeServerMessage));
        socket.on('close', (code) => (closed = code));
      },
    },
  );
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  return { ws, messages, closed: () => closed, until };
}

describe('realtime /ws', () => {
  it('closes with 4401 without a session', async () => {
    const c = await openWs({});
    await c.until(() => c.closed() !== null);
    expect(c.closed()).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('rejects a browser Origin from another host', async () => {
    const cookie = sessionCookie(await login());
    const c = await openWs({ cookie, origin: 'https://evil.example', host: 'localhost:8080' });
    await c.until(() => c.closed() !== null);
    expect(c.closed()).toBe(4403);
  });

  it('pushes subscribed topics and reports unknown ones', async () => {
    const cookie = sessionCookie(await login());
    const c = await openWs({ cookie, origin: 'http://localhost:5173', host: 'localhost:5173' });
    await c.until(() => c.messages.some((m) => m.type === 'hello'));
    c.ws.send(JSON.stringify({ type: 'subscribe', topics: ['status', 'markets:kraken', 'asset:BTC'] }));
    await c.until(() => c.messages.filter((m) => m.type !== 'hello').length >= 3);
    expect(c.messages).toContainEqual({ type: 'data', topic: 'status', data: STATUS });
    expect(c.messages).toContainEqual({ type: 'data', topic: 'asset:BTC', data: { asset: 'BTC' } });
    expect(c.messages).toContainEqual({
      type: 'error',
      topic: 'markets:kraken',
      message: 'Unknown topic: markets:kraken',
    });
    c.ws.send('not json');
    await c.until(() => c.messages.some((m) => m.type === 'error' && m.topic === null));
    c.ws.terminate();
  });
});

describe('LoginThrottle', () => {
  it('forgets failures after the window', () => {
    const t = new LoginThrottle(2, 1_000);
    t.fail('ip', 0);
    t.fail('ip', 10);
    expect(t.blocked('ip', 20)).toBe(true);
    expect(t.blocked('ip', 1_011)).toBe(false);
  });
});
