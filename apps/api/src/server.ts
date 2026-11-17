import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  isExchangeId,
  type AssetDetailResponse,
  type ExchangeId,
  type HealthResponse,
  type Logger,
  type SignalsResponse,
  type UniverseResponse,
} from '@mip/core';
import { isAssetCode, type AssetSource } from './assets.js';
import { registerAuth, requireAuth, type AuthConfig } from './auth.js';
import type { MarketSource } from './markets.js';
import { RealtimeHub, registerRealtime, type TopicResolver } from './realtime.js';
import { isScannerId, type ScannerSource } from './scanners.js';
import type { SessionStore } from './sessions.js';
import type { StatusSource } from './status.js';

export interface ServerDeps {
  logger: Logger;
  auth: AuthConfig;
  cookieSecret: string;
  sessions: SessionStore;
  status: StatusSource;
  markets: MarketSource;
  scanners: ScannerSource;
  assets: AssetSource;
}

/** Realtime topics and how often each is re-read (the collector publishes once per second). */
export function topicResolver(
  deps: Pick<ServerDeps, 'status' | 'markets' | 'scanners' | 'assets'>,
): TopicResolver {
  return (topic) => {
    if (topic === 'status') return { load: () => deps.status.systemStatus(), intervalMs: 1_000 };
    if (topic === 'scanners') return { load: () => deps.scanners.scanners(), intervalMs: 2_000 };
    if (topic === 'signals') return { load: () => deps.scanners.liveSignals(), intervalMs: 1_000 };
    if (topic === 'events') return { load: () => deps.status.connectionEvents(30), intervalMs: 5_000 };
    const [kind, arg] = topic.split(':', 2) as [string, string | undefined];
    if (kind === 'markets' && arg && isExchangeId(arg))
      return { load: () => deps.markets.markets(arg), intervalMs: 1_000 };
    if (kind === 'asset' && arg && isAssetCode(arg))
      return { load: () => deps.assets.asset(arg), intervalMs: 2_000 };
    return null;
  };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Per-request logs come from the onResponse hook below (debug level), not Fastify's defaults.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.addHook('onResponse', async (request, reply) => {
    const entry = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    };
    if (reply.statusCode >= 500) request.log.error(entry, 'request failed');
    else request.log.debug(entry, 'request');
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'Internal server error.' : error.message,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` }),
  );

  await app.register(cookie, { secret: deps.cookieSecret });
  // Small client messages only (subscribe / unsubscribe).
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });
  registerAuth(app, deps.auth, deps.sessions);

  const hub = new RealtimeHub(topicResolver(deps), deps.logger);
  app.addHook('onClose', async () => hub.close());
  registerRealtime(app, hub, deps.sessions, deps.logger);

  app.get('/api/health', async (_request, reply) => {
    const h = await deps.status.health();
    const ok = h.db && h.redis;
    const body: HealthResponse = { status: ok ? 'ok' : 'degraded', ...h };
    return reply.code(ok ? 200 : 503).send(body);
  });

  app.get('/api/system/status', { preHandler: requireAuth }, async () => deps.status.systemStatus());

  app.get<{ Querystring: { limit?: string } }>(
    '/api/system/events',
    { preHandler: requireAuth },
    async (request) => {
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 500);
      return deps.status.connectionEvents(limit);
    },
  );

  app.get<{ Params: { exchange: string } }>(
    '/api/markets/:exchange',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { exchange } = request.params;
      if (!isExchangeId(exchange))
        return reply.code(400).send({ error: 'bad_request', message: `Unknown exchange: ${exchange}` });
      return deps.markets.markets(exchange);
    },
  );

  app.get('/api/universe', { preHandler: requireAuth }, async (): Promise<UniverseResponse> => ({
    universe: await deps.markets.universe(),
  }));

  app.get('/api/scanners', { preHandler: requireAuth }, async () => deps.scanners.scanners());

  app.get('/api/signals/live', { preHandler: requireAuth }, async () => deps.scanners.liveSignals());

  app.get<{
    Querystring: {
      scanner?: string;
      status?: string;
      asset?: string;
      exchange?: string;
      limit?: string;
      before?: string;
    };
  }>('/api/signals', { preHandler: requireAuth }, async (request, reply): Promise<SignalsResponse | void> => {
    const { scanner, status, asset, exchange, limit, before } = request.query;
    if (scanner !== undefined && !isScannerId(scanner))
      return reply.code(400).send({ error: 'bad_request', message: `Unknown scanner: ${scanner}` });
    if (status !== undefined && status !== 'active' && status !== 'resolved')
      return reply.code(400).send({ error: 'bad_request', message: 'status must be active or resolved' });
    if (asset !== undefined && !isAssetCode(asset))
      return reply.code(400).send({ error: 'bad_request', message: `Invalid asset code: ${asset}` });
    if (exchange !== undefined && !isExchangeId(exchange))
      return reply.code(400).send({ error: 'bad_request', message: `Unknown exchange: ${exchange}` });
    const signals = await deps.scanners.signals({
      ...(scanner ? { scanner } : {}),
      ...(status ? { status } : {}),
      ...(asset ? { asset } : {}),
      ...(exchange ? { exchange: exchange as ExchangeId } : {}),
      limit: Math.min(Math.max(Number(limit) || 50, 1), 500),
      ...(Number(before) > 0 ? { before: Number(before) } : {}),
    });
    return { signals };
  });

  app.get<{ Params: { asset: string } }>(
    '/api/assets/:asset',
    { preHandler: requireAuth },
    async (request, reply): Promise<AssetDetailResponse | void> => {
      const { asset } = request.params;
      if (!isAssetCode(asset))
        return reply.code(400).send({ error: 'bad_request', message: `Invalid asset code: ${asset}` });
      return deps.assets.asset(asset);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/scanners/:id/settings',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!isScannerId(id))
        return reply.code(404).send({ error: 'not_found', message: `Unknown scanner: ${id}` });
      return deps.scanners.getSettings(id);
    },
  );

  app.put<{ Params: { id: string }; Body: { enabled?: unknown; settings?: unknown } }>(
    '/api/scanners/:id/settings',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!isScannerId(id))
        return reply.code(404).send({ error: 'not_found', message: `Unknown scanner: ${id}` });
      const result = await deps.scanners.putSettings(id, request.body ?? {});
      if (!result.ok)
        return reply.code(400).send({
          error: 'invalid_settings',
          message: 'Some settings are invalid.',
          problems: result.problems,
        });
      return result.value;
    },
  );

  return app;
}
