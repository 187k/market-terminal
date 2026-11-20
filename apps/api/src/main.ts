import { connectRedis, createRedis, startHeartbeat, TradeBuffer, TradeFeed } from '@mip/bus';
import { DepthFetcher, KlineFetcher } from '@mip/connectors';
import {
  apiEnvSchema,
  apiSecurityWarnings,
  ConfigError,
  createLogger,
  handleShutdown,
  loadDotEnv,
  parseEnv,
} from '@mip/core';
import { createPrismaClient } from '@mip/db';
import { createAssetSource } from './assets.js';
import { createMarketSource } from './markets.js';
import { createOverviewSource } from './overview.js';
import { createScannerSource } from './scanners.js';
import { buildServer } from './server.js';
import { RedisSessionStore } from './sessions.js';
import { createStatusSource } from './status.js';
import { createTerminalSource, redisTerminalReaders, startBanSync } from './terminal.js';

/** Trades kept per instrument for the terminal, and how far back the trade stream is read. */
const TERMINAL_TRADES_PER_INSTRUMENT = 100;
const TERMINAL_TRADES_WINDOW_MS = 6 * 3_600_000;
const TRADE_REPLAY_MS = 60 * 60_000;

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseEnv(apiEnvSchema);
  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  for (const warning of apiSecurityWarnings(env)) logger.warn(`insecure setting: ${warning}`);

  const redis = createRedis(env.REDIS_URL, logger, 'api');
  await connectRedis(redis);
  const prisma = createPrismaClient(env.DATABASE_URL);
  const scanners = createScannerSource(redis, prisma);

  // Terminal: candles and order books on demand from the exchanges' public REST APIs (shared
  // limiters, bans shared through Redis); trades from the collector's stream.
  const baseUrls = env.MEXC_REST_URL ? { mexc: env.MEXC_REST_URL } : {};
  const klines = new KlineFetcher(logger, baseUrls);
  const depth = new DepthFetcher(logger, env.TERMINAL_BOOK_REFRESH_MS, baseUrls);
  const stopBanSync = startBanSync(
    redis,
    [(ex) => klines.pausedUntil(ex), (ex) => depth.pausedUntil(ex)],
    logger,
  );
  const tradeBuffer = new TradeBuffer(TERMINAL_TRADES_WINDOW_MS, TERMINAL_TRADES_PER_INSTRUMENT);
  const tradeRedis = createRedis(env.REDIS_URL, logger, 'api-trades');
  await connectRedis(tradeRedis);
  const tradeFeed = new TradeFeed(tradeRedis, tradeBuffer, logger);
  const tradesSince = Date.now() - TRADE_REPLAY_MS;
  await tradeFeed.start(tradesSince);
  const trimTimer = setInterval(() => tradeBuffer.trim(Date.now()), 10 * 60_000);

  const app = await buildServer({
    logger,
    auth: {
      username: env.DASHBOARD_USER,
      password: env.DASHBOARD_PASSWORD,
      ttlSeconds: env.SESSION_TTL_HOURS * 3600,
      cookieSecure: env.COOKIE_SECURE,
    },
    cookieSecret: env.SESSION_SECRET,
    sessions: new RedisSessionStore(redis),
    status: createStatusSource(redis, prisma),
    markets: createMarketSource(redis),
    scanners,
    assets: createAssetSource(redis, prisma, scanners),
    overview: createOverviewSource(redis, prisma),
    terminal: createTerminalSource({
      ...redisTerminalReaders(redis),
      klines,
      depth,
      trades: tradeBuffer,
      tradesSince: () => tradesSince,
      tradesMinNotional: env.TRADES_MIN_NOTIONAL_USD,
      bookRefreshMs: env.TERMINAL_BOOK_REFRESH_MS,
      candleSyncMs: env.TERMINAL_CANDLE_SYNC_MS,
    }),
  });

  const stopHeartbeat = startHeartbeat(redis, 'api', logger);
  handleShutdown(logger, async () => {
    await app.close();
    stopBanSync();
    clearInterval(trimTimer);
    tradeFeed.stop();
    await stopHeartbeat();
    tradeRedis.disconnect();
    await redis.quit();
    await prisma.$disconnect();
  });

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('api failed to start:', err);
  process.exit(1);
});
