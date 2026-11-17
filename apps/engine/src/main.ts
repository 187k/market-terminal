import {
  CHANNELS,
  connectRedis,
  createRedis,
  readRestPauses,
  startHeartbeat,
  writeRestPause,
  writeScannerStatus,
  writeSignals,
} from '@mip/bus';
import { DepthFetcher, pauseSharedLimiter } from '@mip/connectors';
import {
  ConfigError,
  createLogger,
  engineEnvSchema,
  EXCHANGE_IDS,
  handleShutdown,
  loadDotEnv,
  parseEnv,
} from '@mip/core';
import { createPrismaClient } from '@mip/db';
import { TelegramNotifier, telegramConfigFromEnv } from './notifier.js';
import { ScannerRunner } from './runner.js';
import { prismaHistorySource, SnapshotHistory } from './history.js';
import { fairPriceScanner } from './scanners/fair-price.js';
import { createFundingScanner } from './scanners/funding.js';
import { createOpenInterestScanner } from './scanners/open-interest.js';
import { createSpreadScanner } from './scanners/spread.js';
import { createTwapScanner } from './scanners/twap.js';
import { HlTwapWatcher } from './hl-twap.js';
import { TradeBuffer, TradeFeed } from './trades.js';
import { SettingsStore } from './settings.js';
import { SignalEngine } from './signals.js';
import { PrismaSignalStore } from './store.js';
import { readView } from './view.js';

const TICK_MS = 1_000;
const COUNTS_EVERY_MS = 60_000;
/** New per-minute snapshots are picked up this often. */
const HISTORY_EVERY_MS = 20_000;
/** Longest cooldown we restore signals for after a restart. */
const RESTORE_WINDOW_MS = 7 * 86_400_000;

/** Analytics engine: scanners → signals → Telegram, PostgreSQL and Redis. */
async function main(): Promise<void> {
  loadDotEnv();
  const env = parseEnv(engineEnvSchema);
  const logger = createLogger({ service: 'engine', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });

  const redis = createRedis(env.REDIS_URL, logger, 'engine');
  await connectRedis(redis);
  const subscriber = createRedis(env.REDIS_URL, logger, 'engine-sub');
  await connectRedis(subscriber);
  const prisma = createPrismaClient(env.DATABASE_URL);

  const store = new PrismaSignalStore(prisma);
  const notifier = new TelegramNotifier(telegramConfigFromEnv(env), { logger });
  await notifier.verify();
  const settings = new SettingsStore(prisma, logger);
  await settings.load();

  // 4 h OI windows need 4.5 h; the last settlement of an 8 h funding interval needs more than 8 h.
  const history = new SnapshotHistory(prismaHistorySource(prisma), 9 * 3_600_000);
  // Order books are fetched on demand for spread candidates only.
  const depth = new DepthFetcher(logger, undefined, env.MEXC_REST_URL ? { mexc: env.MEXC_REST_URL } : {});
  // Trades from the collector's stream; the last window is re-read at start-up.
  const tradeBuffer = new TradeBuffer(60 * 60_000);
  const tradeRedis = createRedis(env.REDIS_URL, logger, 'engine-trades');
  await connectRedis(tradeRedis);
  const tradeFeed = new TradeFeed(tradeRedis, tradeBuffer, logger);
  const replayed = await tradeFeed.start(Date.now() - 60 * 60_000);
  logger.info({ trades: replayed }, 'recent trades loaded');
  const twapWatcher = new HlTwapWatcher(logger);
  twapWatcher.start();
  const scanners = [
    fairPriceScanner,
    createOpenInterestScanner(history),
    createFundingScanner(history),
    createSpreadScanner(depth),
    createTwapScanner(tradeBuffer, twapWatcher),
  ];
  const engine = new SignalEngine({ store, notifier, logger });
  for (const s of scanners) engine.register(s);
  const restored = await engine.restore(Date.now(), RESTORE_WINDOW_MS);
  if (restored > 0) logger.info({ restored }, 'restored open and cooling signals');

  const runner = new ScannerRunner({
    scanners,
    engine,
    settings,
    telegramStatus: (id) => notifier.status(id),
    logger,
  });

  // Settings edited in the dashboard take effect within a second; a periodic reload is the fallback.
  await subscriber.subscribe(CHANNELS.settingsChanged);
  subscriber.on(
    'message',
    () =>
      void settings.load().catch((err: Error) => logger.warn({ err: err.message }, 'settings reload failed')),
  );
  const reloadTimer = setInterval(() => void settings.load().catch(() => undefined), 60_000);

  // Resolved signals are history for the dashboard; keep SIGNAL_RETENTION_DAYS of them.
  const purgeSignals = async () => {
    try {
      const deleted = await store.purgeResolved(Date.now() - env.SIGNAL_RETENTION_DAYS * 86_400_000);
      if (deleted > 0) logger.info({ deleted }, 'old resolved signals deleted');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'deleting old signals failed');
    }
  };
  void purgeSignals();
  const purgeTimer = setInterval(() => void purgeSignals(), 3_600_000);

  let counts = await store.counts24h(Date.now()).catch(() => new Map());
  let countsAt = Date.now();
  const loaded = await history.refresh(Date.now());
  logger.info(
    { snapshots: loaded, coverageMin: Math.round(history.coverageMs(Date.now()) / 60_000) },
    'market history loaded',
  );
  let historyAt = Date.now();
  // Bans are per IP and shared with the collector: honour the ones it recorded, and record ours.
  const syncBans = async () => {
    const pauses = await readRestPauses(redis, EXCHANGE_IDS).catch(() => ({}));
    for (const [exchange, until] of Object.entries(pauses))
      pauseSharedLimiter(`${exchange}/rest`, until as number);
    for (const exchange of EXCHANGE_IDS) {
      const until = depth.pausedUntil(exchange);
      if (until) await writeRestPause(redis, exchange, until).catch(() => undefined);
    }
  };
  await syncBans();

  let busy = false;
  const tick = async () => {
    if (busy) return; // a slow tick is skipped, never stacked
    busy = true;
    try {
      const now = Date.now();
      if (now - historyAt >= HISTORY_EVERY_MS) {
        await history
          .refresh(now)
          .catch((err: Error) => logger.warn({ err: err.message }, 'history refresh failed'));
        historyAt = now;
      }
      const view = await readView(redis, now);
      await runner.tick(view, now);
      for (const def of runner.scanners) {
        if (engine.takeDirty(def.id)) {
          await writeSignals(redis, def.id, {
            ts: now,
            active: engine.active(def.id),
            recent: engine.recent(def.id),
          });
        }
      }
      if (now - countsAt >= COUNTS_EVERY_MS) {
        counts = await store.counts24h(now).catch(() => counts);
        countsAt = now;
        await syncBans();
      }
      await writeScannerStatus(redis, runner.statuses(counts));
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'engine tick failed');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  const stopHeartbeat = startHeartbeat(redis, 'engine', logger);

  handleShutdown(logger, async () => {
    clearInterval(timer);
    clearInterval(reloadTimer);
    clearInterval(purgeTimer);
    tradeFeed.stop();
    await twapWatcher.stop();
    await engine.settle();
    tradeRedis.disconnect();
    await stopHeartbeat();
    await subscriber.quit();
    await redis.quit();
    await prisma.$disconnect();
  });

  logger.info(
    {
      scanners: scanners.map((s) => s.id),
      telegram: scanners.map((s) => `${s.id}:${notifier.status(s.id).state}`),
    },
    'engine running',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('engine failed to start:', err);
  process.exit(1);
});
