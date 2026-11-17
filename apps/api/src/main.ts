import { connectRedis, createRedis, startHeartbeat } from '@mip/bus';
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
import { createScannerSource } from './scanners.js';
import { buildServer } from './server.js';
import { RedisSessionStore } from './sessions.js';
import { createStatusSource } from './status.js';

async function main(): Promise<void> {
  loadDotEnv();
  const env = parseEnv(apiEnvSchema);
  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  for (const warning of apiSecurityWarnings(env)) logger.warn(`insecure setting: ${warning}`);

  const redis = createRedis(env.REDIS_URL, logger, 'api');
  await connectRedis(redis);
  const prisma = createPrismaClient(env.DATABASE_URL);
  const scanners = createScannerSource(redis, prisma);

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
  });

  const stopHeartbeat = startHeartbeat(redis, 'api', logger);
  handleShutdown(logger, async () => {
    await app.close();
    await stopHeartbeat();
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
