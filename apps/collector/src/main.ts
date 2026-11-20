import {
  connectRedis,
  createRedis,
  publishConnectionEvent,
  readRestPauses,
  startHeartbeat,
  writeExchangeHealth,
  writeInstruments,
  writeMarketOverview,
  writeMarketSnapshots,
  writeRestPause,
  writeUniverse,
} from '@mip/bus';
import {
  CoinGeckoClient,
  CONNECTOR_CAPABILITIES,
  CONNECTOR_FACTORIES,
  ConnectorSupervisor,
  pauseSharedLimiter,
  type Credentials,
} from '@mip/connectors';
import {
  collectorEnvSchema,
  ConfigError,
  createLogger,
  handleShutdown,
  loadDotEnv,
  parseEnv,
  type CollectorEnv,
  type ExchangeId,
  type InstrumentInfo,
  type MarketsBootstrap,
  type TradeEvent,
  type UniverseInfo,
} from '@mip/core';
import { createPrismaClient } from '@mip/db';
import { ConnectionEventWriter } from './event-writer.js';
import { MarketState } from './market-state.js';
import { MarketOverviewPoller } from './overview.js';
import { symbolsFor } from './universe/select.js';
import { SnapshotWriter } from './snapshots.js';
import { TradeForwarder } from './trades.js';
import { UniverseService } from './universe/service.js';

const PUBLISH_MS = 1_000;

/** Read-only keys from the environment; an exchange gets credentials only when key and secret are both set. */
function credentialsFromEnv(env: CollectorEnv): Partial<Record<ExchangeId, Credentials>> {
  const pairs: Record<ExchangeId, [string | undefined, string | undefined, string?]> = {
    bybit: [env.BYBIT_API_KEY, env.BYBIT_API_SECRET],
    binance: [env.BINANCE_API_KEY, env.BINANCE_API_SECRET],
    mexc: [env.MEXC_API_KEY, env.MEXC_API_SECRET],
    hyperliquid: [undefined, undefined],
    bitget: [env.BITGET_API_KEY, env.BITGET_API_SECRET, env.BITGET_API_PASSPHRASE],
    bingx: [env.BINGX_API_KEY, env.BINGX_API_SECRET],
    gate: [env.GATE_API_KEY, env.GATE_API_SECRET],
  };
  const out: Partial<Record<ExchangeId, Credentials>> = {};
  for (const [exchange, [apiKey, apiSecret, passphrase]] of Object.entries(pairs) as [
    ExchangeId,
    [string?, string?, string?],
  ][]) {
    if (apiKey && apiSecret) out[exchange] = { apiKey, apiSecret, ...(passphrase ? { passphrase } : {}) };
  }
  return out;
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseEnv(collectorEnvSchema);
  const logger = createLogger({ service: 'collector', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });

  const redis = createRedis(env.REDIS_URL, logger, 'collector');
  await connectRedis(redis);
  const prisma = createPrismaClient(env.DATABASE_URL);
  const events = new ConnectionEventWriter(prisma, logger, {
    retentionDays: env.CONNECTION_EVENT_RETENTION_DAYS,
  });
  void events.purge();
  const state = new MarketState();
  const credentials = credentialsFromEnv(env);
  const coingecko = new CoinGeckoClient({
    logger,
    ...(env.COINGECKO_API_KEY ? { apiKey: env.COINGECKO_API_KEY } : {}),
    plan: env.COINGECKO_API_PLAN,
  });
  // Home page figures share the CoinGecko client, so they share its rate limiter with the universe.
  const overview = new MarketOverviewPoller({
    source: coingecko,
    write: (value) => writeMarketOverview(redis, value),
    logger,
    refreshMs: env.OVERVIEW_REFRESH_SEC * 1_000,
  });

  const startable = env.EXCHANGES_ENABLED.filter((e) => CONNECTOR_FACTORIES[e]);
  for (const ex of startable) state.register(ex, CONNECTOR_CAPABILITIES[ex]!);

  const publishUniverse = async (universe: UniverseInfo, instruments: Map<ExchangeId, InstrumentInfo[]>) => {
    const tracked: Partial<Record<ExchangeId, InstrumentInfo[]>> = {};
    for (const [ex, list] of instruments) {
      const wanted = new Set(symbolsFor(universe, ex));
      tracked[ex] = list.filter((i) => wanted.has(i.symbol));
    }
    await writeUniverse(redis, universe);
    await writeInstruments(redis, {
      ts: Date.now(),
      instruments: tracked,
      capabilities: Object.fromEntries(startable.map((ex) => [ex, CONNECTOR_CAPABILITIES[ex]!])),
    });
  };

  const universe = new UniverseService({
    logger,
    prisma,
    coingecko,
    settings: {
      size: env.UNIVERSE_SIZE,
      ranking: env.UNIVERSE_RANKING,
      refreshHours: env.UNIVERSE_REFRESH_HOURS,
      maxDeviation: env.UNIVERSE_MAX_PRICE_DEVIATION,
    },
    expected: startable,
    onChange: (u, instruments) => {
      void publishUniverse(u, instruments).catch((err: Error) =>
        logger.warn({ err: err.message }, 'publishing universe failed'),
      );
      overview.setUniverse(u);
      // Started from an outdated stored ranking: refresh from CoinGecko in the background.
      if (universe.needsRefresh && !refreshScheduled) {
        refreshScheduled = true;
        setTimeout(
          () =>
            void refreshUniverse().catch((err: Error) =>
              logger.error({ err: err.message }, 'background universe refresh failed'),
            ),
          15_000,
        ).unref();
      }
    },
  });
  let refreshScheduled = false;

  const trades = env.TRADES_ENABLED ? new TradeForwarder(redis, env.TRADES_MIN_NOTIONAL_USD, logger) : null;
  trades?.start();

  const mexcEndpoints = {
    ...(env.MEXC_REST_URL ? { restUrl: env.MEXC_REST_URL } : {}),
    ...(env.MEXC_WS_URL ? { wsUrl: env.MEXC_WS_URL } : {}),
  };
  const supervisor = new ConnectorSupervisor({
    enabled: env.EXCHANGES_ENABLED,
    factories: CONNECTOR_FACTORIES,
    logger,
    credentials,
    endpoints: Object.keys(mexcEndpoints).length > 0 ? { mexc: mexcEndpoints } : {},
    sink: {
      market: (exchange, update) => state.apply(exchange, update),
      instruments: (exchange, list) => state.setInstrumentCount(exchange, list.length),
      // Without this hook the connectors do not subscribe to trades at all.
      ...(trades ? { trade: (t: TradeEvent) => trades.push(t) } : {}),
    },
    selectSymbols: async (exchange, boot) => {
      const symbols = await universe.select(exchange, boot);
      state.setTracked(exchange, symbols);
      return symbols;
    },
    onLoadFailed: (exchange) => universe.loadFailed(exchange),
  });
  supervisor.on('connection', (event) => {
    events.push(event);
    if (event.state !== 'open') state.connectionDown(event.exchange, event.connection, event.at);
    void publishConnectionEvent(redis, event).catch(() => undefined);
  });

  const publish = async () => {
    const now = Date.now();
    const exchanges = state.exchanges().filter((ex) => state.tracked(ex).length > 0);
    await writeMarketSnapshots(
      redis,
      exchanges.map((ex) => state.snapshot(ex, now)),
    );
    const health = supervisor.health().map((h) => ({ ...h, data: state.dataHealth(h.exchange, now) }));
    await writeExchangeHealth(redis, health);
    // Remember bans / rate-limit pauses so a restarted collector keeps honouring them.
    for (const h of health) {
      const until = h.rest?.pausedUntil;
      if (until && until > now && until !== recordedPauses.get(h.exchange)) {
        recordedPauses.set(h.exchange, until);
        await writeRestPause(redis, h.exchange, until);
      }
    }
  };
  const recordedPauses = new Map<ExchangeId, number>();
  const publishTimer = setInterval(
    () =>
      void publish().catch((err: Error) =>
        logger.warn({ err: err.message }, 'publishing market state failed'),
      ),
    PUBLISH_MS,
  );

  // Daily: fresh CoinGecko ranking and instrument lists, then new tracked sets.
  const refreshUniverse = async () => {
    const boots = new Map<ExchangeId, MarketsBootstrap>();
    await Promise.all(
      startable.map(async (ex) => {
        const connector = supervisor.connector(ex);
        // Only running connectors: one that is still starting (e.g. waiting out a ban) is skipped.
        if (!connector || connector.health().state === 'starting') return;
        const boot = await Promise.race([
          connector.loadMarkets(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timed out after 60 s')), 60_000).unref(),
          ),
        ]).catch((err: Error) => {
          logger.warn(
            { exchange: ex, err: err.message },
            'reloading markets for the universe refresh failed',
          );
          return null;
        });
        if (boot) boots.set(ex, boot);
      }),
    );
    const u = await universe.refresh(boots);
    for (const ex of boots.keys()) {
      const symbols = symbolsFor(u, ex);
      state.setTracked(ex, symbols);
      supervisor.setTracked(ex, symbols);
    }
  };
  const refreshTimer = setInterval(
    () =>
      void refreshUniverse().catch((err: Error) =>
        logger.error({ err: err.message }, 'universe refresh failed'),
      ),
    env.UNIVERSE_REFRESH_HOURS * 3_600_000,
  );

  const stopHeartbeat = startHeartbeat(redis, 'collector', logger);
  const snapshots = new SnapshotWriter(prisma, state, logger, env.MARKET_SNAPSHOT_RETENTION_DAYS);
  snapshots.start();

  handleShutdown(logger, async () => {
    overview.stop();
    snapshots.stop();
    await trades?.stop();
    clearInterval(publishTimer);
    clearInterval(refreshTimer);
    universe.stop();
    await supervisor.stop();
    await events.close();
    await stopHeartbeat();
    await redis.quit();
    await prisma.$disconnect();
  });

  logger.info(
    {
      exchanges: env.EXCHANGES_ENABLED,
      universe: { size: env.UNIVERSE_SIZE, ranking: env.UNIVERSE_RANKING },
      coingecko: coingecko.plan,
      apiKeys: Object.keys(credentials),
    },
    'collector starting',
  );
  // Bans recorded by a previous process: hold those exchanges' REST requests until they end.
  const pauses = await readRestPauses(redis, startable);
  for (const [exchange, until] of Object.entries(pauses) as [ExchangeId, number][]) {
    pauseSharedLimiter(`${exchange}/rest`, until);
    logger.warn(
      { exchange, until: new Date(until).toISOString() },
      'exchange paused us before the restart; holding its REST requests until then',
    );
  }
  await publish();
  overview.start();
  await supervisor.start();
  logger.info('collector running');
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('collector failed to start:', err);
  process.exit(1);
});
