import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EXCHANGE_IDS, isExchangeId, type ExchangeId } from './types/exchanges.js';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Loads the nearest `.env` file, walking up from `startDir` to the repository root
 * (the first directory containing package-lock.json). Variables already present in
 * the environment win over the file. Returns the file path, or null if none was found.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
    const parent = path.dirname(dir);
    if (existsSync(path.join(dir, 'package-lock.json')) || parent === dir) return null;
    dir = parent;
  }
}

/** Parses environment variables with a zod schema. Error messages never include values. */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  // Treat empty strings as unset so `KEY=` in .env falls back to defaults / optional.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `${key}: ${issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message}`;
  });
  throw new ConfigError(problems);
}

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const exchangeList = z.string().transform((value, ctx): ExchangeId[] => {
  const ids = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = ids.filter((id) => !isExchangeId(id));
  if (unknown.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `unknown exchange(s): ${unknown.join(', ')}; allowed: ${EXCHANGE_IDS.join(', ')}`,
    });
    return z.NEVER;
  }
  return [...new Set(ids)] as ExchangeId[];
});

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanString.default(false),
  REDIS_URL: z.url(),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url(),
});

const optionalSecret = z.string().min(1).optional();

export const collectorEnvSchema = baseEnvSchema.extend({
  ...databaseEnvSchema.shape,
  EXCHANGES_ENABLED: exchangeList.default([...EXCHANGE_IDS]),
  /** Number of assets to monitor. */
  UNIVERSE_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  /** How assets are ranked: CoinGecko market cap, or summed 24 h perpetual turnover. */
  UNIVERSE_RANKING: z.enum(['market_cap', 'volume']).default('market_cap'),
  UNIVERSE_REFRESH_HOURS: z.coerce.number().positive().default(24),
  /** Largest relative gap between an instrument's price and the reference price for a mapping to count. */
  UNIVERSE_MAX_PRICE_DEVIATION: z.coerce.number().positive().max(1).default(0.15),
  COINGECKO_API_KEY: optionalSecret,
  COINGECKO_API_PLAN: z.enum(['demo', 'pro']).default('demo'),
  // Read-only exchange keys (optional). Used only where an endpoint requires a key.
  BYBIT_API_KEY: optionalSecret,
  BYBIT_API_SECRET: optionalSecret,
  BINANCE_API_KEY: optionalSecret,
  BINANCE_API_SECRET: optionalSecret,
  MEXC_API_KEY: optionalSecret,
  MEXC_API_SECRET: optionalSecret,
  BITGET_API_KEY: optionalSecret,
  BITGET_API_SECRET: optionalSecret,
  BITGET_API_PASSPHRASE: optionalSecret,
  BINGX_API_KEY: optionalSecret,
  BINGX_API_SECRET: optionalSecret,
  GATE_API_KEY: optionalSecret,
  GATE_API_SECRET: optionalSecret,
  /** Stream public trades to the engine (needed by the TWAP / DCA detector). */
  TRADES_ENABLED: booleanString.default(true),
  /** Trades smaller than this (price × size, quote currency) are not forwarded; Hyperliquid TWAP slices always are. */
  TRADES_MIN_NOTIONAL_USD: z.coerce.number().min(0).default(500),
  /** Days of per-minute market snapshots kept in PostgreSQL (history for OI windows and funding). */
  MARKET_SNAPSHOT_RETENTION_DAYS: z.coerce.number().positive().max(365).default(7),
  /** Days of WebSocket / REST connection events kept in PostgreSQL. */
  CONNECTION_EVENT_RETENTION_DAYS: z.coerce.number().positive().max(3650).default(30),
  /** Host overrides for networks where MEXC's documented hosts are blocked (leave empty normally). */
  MEXC_REST_URL: z.url().optional(),
  MEXC_WS_URL: z.url().optional(),
});

/** Telegram: one chat (forum supergroup) with one topic and one bot per scanner. All optional. */
const telegramShape = {
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  TELEGRAM_FAIR_PRICE_BOT_TOKEN: optionalSecret,
  TELEGRAM_FAIR_PRICE_TOPIC_ID: z.coerce.number().int().optional(),
  TELEGRAM_OPEN_INTEREST_BOT_TOKEN: optionalSecret,
  TELEGRAM_OPEN_INTEREST_TOPIC_ID: z.coerce.number().int().optional(),
  TELEGRAM_FUNDING_BOT_TOKEN: optionalSecret,
  TELEGRAM_FUNDING_TOPIC_ID: z.coerce.number().int().optional(),
  TELEGRAM_SPREAD_BOT_TOKEN: optionalSecret,
  TELEGRAM_SPREAD_TOPIC_ID: z.coerce.number().int().optional(),
  TELEGRAM_TWAP_BOT_TOKEN: optionalSecret,
  TELEGRAM_TWAP_TOPIC_ID: z.coerce.number().int().optional(),
};

export const engineEnvSchema = baseEnvSchema.extend({
  ...databaseEnvSchema.shape,
  ...telegramShape,
  /**
   * Days resolved signals are kept (history in the dashboard). At least 8: restarts restore
   * signals of the last 7 days so cooldowns survive them.
   */
  SIGNAL_RETENTION_DAYS: z.coerce.number().min(8).max(3650).default(90),
  /** Same override as the collector's: the engine fetches MEXC order books for the spread scanner. */
  MEXC_REST_URL: z.url().optional(),
});

export const apiEnvSchema = baseEnvSchema.extend({
  ...databaseEnvSchema.shape,
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DASHBOARD_USER: z.string().min(1),
  DASHBOARD_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(16, 'must be at least 16 characters'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  COOKIE_SECURE: booleanString.default(false),
  /** Same override as the collector's: the terminal fetches MEXC candles and order books. */
  MEXC_REST_URL: z.url().optional(),
  /** The collector's trade filter, shown next to the terminal's trade list (same `.env`). */
  TRADES_MIN_NOTIONAL_USD: z.coerce.number().min(0).default(500),
  /** How often the terminal re-requests the viewed order book from the exchange (REST). */
  TERMINAL_BOOK_REFRESH_MS: z.coerce.number().int().min(1_000).max(60_000).default(2_000),
  /** How often the terminal re-syncs the newest candles from the exchange (REST). */
  TERMINAL_CANDLE_SYNC_MS: z.coerce.number().int().min(2_000).max(300_000).default(10_000),
});

/** Example values from `.env.example` that must not survive into production. */
const EXAMPLE_VALUES = new Set(['change-me', 'replace-with-a-long-random-string']);

/**
 * Settings that work but are unsafe on a server. Returned as messages (never containing the
 * values) for the API to log at startup; only checked when NODE_ENV=production.
 */
export function apiSecurityWarnings(
  env: Pick<ApiEnv, 'NODE_ENV' | 'DASHBOARD_PASSWORD' | 'SESSION_SECRET' | 'COOKIE_SECURE' | 'DATABASE_URL'>,
): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  if (EXAMPLE_VALUES.has(env.DASHBOARD_PASSWORD)) out.push('DASHBOARD_PASSWORD is still the example value');
  else if (env.DASHBOARD_PASSWORD.length < 12) out.push('DASHBOARD_PASSWORD is shorter than 12 characters');
  if (EXAMPLE_VALUES.has(env.SESSION_SECRET)) out.push('SESSION_SECRET is still the example value');
  else if (env.SESSION_SECRET.length < 32) out.push('SESSION_SECRET is shorter than 32 characters');
  if (!env.COOKIE_SECURE)
    out.push(
      'COOKIE_SECURE is false: fine on localhost, but set it to true when the dashboard is served over HTTPS',
    );
  try {
    if (decodeURIComponent(new URL(env.DATABASE_URL).password) === 'mip')
      out.push('the database password is the default (POSTGRES_PASSWORD)');
  } catch {
    // DATABASE_URL was validated as a URL already
  }
  return out;
}

export type BaseEnv = z.output<typeof baseEnvSchema>;
export type CollectorEnv = z.output<typeof collectorEnvSchema>;
export type EngineEnv = z.output<typeof engineEnvSchema>;
export type ApiEnv = z.output<typeof apiEnvSchema>;
