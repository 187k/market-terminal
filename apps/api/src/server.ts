import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  isCandleInterval,
  isExchangeId,
  type AssetDetailResponse,
  type CandleInterval,
  type CandlesResponse,
  type ExchangeId,
  type HealthResponse,
  type Logger,
  type SignalsResponse,
  type TerminalLiveResponse,
  type UniverseResponse,
} from '@mip/core';
import { isAssetCode, type AssetSource } from './assets.js';
import { registerAuth, requireAuth, type AuthConfig } from './auth.js';
import type { MarketSource } from './markets.js';
import type { OverviewSource } from './overview.js';
import { RealtimeHub, registerRealtime, type TopicResolver } from './realtime.js';
import { isScannerId, type ScannerSource } from './scanners.js';
import type { SessionStore } from './sessions.js';
import type { StatusSource } from './status.js';
import { HISTORY_PAGE, isInstrumentSymbol, type TerminalSource } from './terminal.js';

export interface ServerDeps {
  logger: Logger;
  auth: AuthConfig;
  cookieSecret: string;
  sessions: SessionStore;
  status: StatusSource;
  markets: MarketSource;
  scanners: ScannerSource;
  assets: AssetSource;
  terminal: TerminalSource;
  overview: OverviewSource;
}

/** Realtime topics and how often each is re-read (the collector publishes once per second). */
export function topicResolver(
  deps: Pick<ServerDeps, 'status' | 'markets' | 'scanners' | 'assets' | 'terminal' | 'overview'>,
): TopicResolver {
  return (topic) => {
    if (topic.startsWith('terminal:')) {
      const [, exchange, symbol, interval, extra] = topic.split(':');
      if (extra !== undefined || !exchange || !symbol || !interval) return null;
      if (!isExchangeId(exchange) || !isInstrumentSymbol(symbol) || !isCandleInterval(interval)) return null;
      return { load: () => deps.terminal.live(exchange, symbol, interval), intervalMs: 1_000 };
    }
    if (topic === 'status') return { load: () => deps.status.systemStatus(), intervalMs: 1_000 };
    if (topic === 'scanners') return { load: () => deps.scanners.scanners(), intervalMs: 2_000 };
    if (topic === 'signals') return { load: () => deps.scanners.liveSignals(), intervalMs: 1_000 };
    if (topic === 'events') return { load: () => deps.status.connectionEvents(30), intervalMs: 5_000 };
    // CoinGecko figures change once per collector poll (minutes); unchanged payloads are not re-sent.
    if (topic === 'overview') return { load: () => deps.overview.overview(), intervalMs: 5_000 };
    // Funding and open interest move slowly; every 5 s is plenty for the home page.
    if (topic === 'perps') return { load: () => deps.overview.perps(), intervalMs: 5_000 };
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

  app.get('/api/overview', { preHandler: requireAuth }, async () => deps.overview.overview());

  app.get('/api/overview/perps', { preHandler: requireAuth }, async () => deps.overview.perps());

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

  app.get<{ Params: { exchange: string; symbol: string }; Querystring: { interval?: string } }>(
    '/api/terminal/:exchange/:symbol',
    { preHandler: requireAuth },
    async (request, reply): Promise<TerminalLiveResponse | void> => {
      const { exchange, symbol } = request.params;
      const interval = request.query.interval ?? '5m';
      const problem = terminalParamProblem(exchange, symbol, interval);
      if (problem) return reply.code(400).send({ error: 'bad_request', message: problem });
      return deps.terminal.live(exchange as ExchangeId, symbol, interval as CandleInterval);
    },
  );

  app.get<{
    Params: { exchange: string; symbol: string };
    Querystring: { interval?: string; limit?: string; before?: string };
  }>(
    '/api/terminal/:exchange/:symbol/candles',
    { preHandler: requireAuth },
    async (request, reply): Promise<CandlesResponse | void> => {
      const { exchange, symbol } = request.params;
      const { interval = '5m', limit, before } = request.query;
      const problem = terminalParamProblem(exchange, symbol, interval);
      if (problem) return reply.code(400).send({ error: 'bad_request', message: problem });
      try {
        const res = await deps.terminal.candles(exchange as ExchangeId, symbol, interval as CandleInterval, {
          limit: Math.min(Math.max(Number(limit) || HISTORY_PAGE, 1), HISTORY_PAGE),
          ...(Number(before) > 0 ? { before: Number(before) } : {}),
        });
        if (!res)
          return reply
            .code(404)
            .send({ error: 'not_found', message: `${symbol} is not tracked on ${exchange}` });
        return res;
      } catch (err) {
        request.log.warn({ err: (err as Error).message, exchange, symbol }, 'candle request failed');
        return reply.code(502).send({ error: 'upstream_error', message: (err as Error).message });
      }
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

/** Validates terminal route parameters; returns a message for a 400, or null. */
function terminalParamProblem(exchange: string, symbol: string, interval: string): string | null {
  if (!isExchangeId(exchange)) return `Unknown exchange: ${exchange}`;
  if (!isInstrumentSymbol(symbol)) return `Invalid symbol: ${symbol}`;
  if (!isCandleInterval(interval)) return `Unknown interval: ${interval}`;
  return null;
}
