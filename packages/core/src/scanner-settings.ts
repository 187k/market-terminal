import { z } from 'zod';
import { EXCHANGE_IDS } from './types/exchanges.js';
import type { OiWindow, ScannerId } from './types/scanners.js';

/**
 * Settings every scanner has: filters, deduplication and notification behaviour.
 * All values can be changed at runtime (dashboard / API) without touching code.
 */
export const commonSettingsShape = {
  /** Send Telegram messages (signals are recorded and shown in the dashboard either way). */
  notifyTelegram: z.boolean().default(true),
  /** Only these exchanges; empty = all. */
  exchanges: z.array(z.enum(EXCHANGE_IDS)).default([]),
  /** Only these asset codes (e.g. "BTC"); empty = all. */
  includeAssets: z.array(z.string().min(1)).default([]),
  /** Never these asset codes. */
  excludeAssets: z.array(z.string().min(1)).default([]),
  /** Minimum 24 h turnover of the instrument, quote currency (USDT / USDC ≈ USD). */
  minTurnover24hUsd: z.number().min(0).default(1_000_000),
  /** A condition must hold this long before a signal opens (filters single-tick noise). */
  confirmSec: z.number().min(0).max(3600).default(5),
  /** A signal resolves after its condition has been absent this long. */
  resolveAfterSec: z.number().min(0).max(86_400).default(60),
  /** After resolving, the same signal reappearing within this time reopens it instead of a new message. */
  cooldownMinutes: z.number().min(0).max(10_080).default(30),
  /** Minimum time between edits of an open signal's message. */
  minUpdateIntervalSec: z.number().min(0).max(86_400).default(60),
  /** Relative change of the main metric that counts as significant (edits the message), percent. */
  significantChangePct: z.number().min(0).max(1000).default(25),
  /** Edit the message when the signal resolves. */
  notifyResolved: z.boolean().default(true),
};

export const fairPriceSettingsSchema = z.object({
  ...commonSettingsShape,
  /** |last − mark| / mark × 100 must reach this. */
  minDeviationPct: z.number().min(0).max(100).default(0.5),
  /**
   * Also require the order book to still offer the deviation: ask below mark for LONG, bid
   * above mark for SHORT, by at least `minExecutableEdgePct`. Filters stale last prices.
   */
  requireExecutable: z.boolean().default(true),
  minExecutableEdgePct: z.number().min(0).max(100).default(0.1),
  /** Warn when |mark − index| / index × 100 exceeds this. */
  fairIndexWarnPct: z.number().min(0).max(100).default(0.5),
  /** Notional at the best level on the side you would take. */
  minTopOfBookUsd: z.number().min(0).default(1_000),
  /** Ignore books wider than this (bid–ask spread, percent of mid). */
  maxSpreadPct: z.number().min(0).max(100).default(2),
});

export const OI_WINDOW_MS: Record<OiWindow, number> = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

const oiThreshold = (growthPct: number, declinePct: number) =>
  z
    .object({ growthPct: z.number().min(0).max(1000), declinePct: z.number().min(0).max(100) })
    .default({ growthPct, declinePct });

export const openInterestSettingsSchema = z.object({
  ...commonSettingsShape,
  // OI windows are already averaged over minutes; no extra confirmation needed.
  confirmSec: z.number().min(0).max(3600).default(0),
  resolveAfterSec: z.number().min(0).max(86_400).default(300),
  cooldownMinutes: z.number().min(0).max(10_080).default(60),
  minUpdateIntervalSec: z.number().min(0).max(86_400).default(300),
  /** Signal when OI grows / declines by at least this much within the window (percent). */
  thresholds: z
    .object({
      '5m': oiThreshold(3, 3),
      '30m': oiThreshold(8, 6),
      '1h': oiThreshold(12, 8),
      '4h': oiThreshold(25, 15),
    })
    .default({
      '5m': { growthPct: 3, declinePct: 3 },
      '30m': { growthPct: 8, declinePct: 6 },
      '1h': { growthPct: 12, declinePct: 8 },
      '4h': { growthPct: 25, declinePct: 15 },
    }),
  signalOnGrowth: z.boolean().default(true),
  signalOnDecline: z.boolean().default(true),
  /** Current OI × mark price. */
  minOiUsd: z.number().min(0).default(2_000_000),
  /** Notional at the best bid and at the best ask (the smaller of the two). */
  minTopOfBookUsd: z.number().min(0).default(1_000),
});

export const fundingSettingsSchema = z.object({
  ...commonSettingsShape,
  // Funding moves slowly; wait before announcing and keep messages calm.
  confirmSec: z.number().min(0).max(3600).default(60),
  resolveAfterSec: z.number().min(0).max(86_400).default(600),
  cooldownMinutes: z.number().min(0).max(10_080).default(240),
  minUpdateIntervalSec: z.number().min(0).max(86_400).default(900),
  /** |funding normalised to 24 h| that counts as extreme, percent. */
  extreme24hPct: z.number().min(0).max(100).default(0.3),
  signalExtremes: z.boolean().default(true),
  /** Difference between the highest and lowest 24 h funding of one asset across exchanges, percent. */
  minDifference24hPct: z.number().min(0).max(100).default(0.15),
  signalArbitrage: z.boolean().default(true),
});

const fee = (v: number) => z.number().min(0).max(0.01).default(v);

/**
 * Default taker fees (fraction): published base-tier rates, or the contract metadata where the
 * exchange publishes it (MEXC, Bitget, BingX, Gate). Your account tier may differ: adjust here.
 */
export const DEFAULT_TAKER_FEES = {
  bybit: 0.00055,
  binance: 0.0005,
  mexc: 0.0004,
  hyperliquid: 0.00045,
  bitget: 0.0006,
  bingx: 0.0005,
  gate: 0.00075,
} as const;

export const spreadSettingsSchema = z.object({
  ...commonSettingsShape,
  confirmSec: z.number().min(0).max(3600).default(3),
  resolveAfterSec: z.number().min(0).max(86_400).default(30),
  cooldownMinutes: z.number().min(0).max(10_080).default(15),
  /** Gross spread (best bid of the dearer venue vs best ask of the cheaper one), percent. */
  minGrossSpreadPct: z.number().min(0).max(100).default(0.3),
  /** Net spread after fees, VWAP slippage and funding, percent of the purchase. */
  minNetSpreadPct: z.number().min(-100).max(100).default(0.1),
  /** Position size per leg used for VWAP and profit, USD. */
  positionUsd: z.number().positive().default(10_000),
  /** Funding is charged / credited over this holding period, hours (0 = ignore funding). */
  holdingHours: z.number().min(0).max(720).default(8),
  /** Larger gaps are treated as a probable instrument-mapping problem, never as a signal. */
  maxPlausibleSpreadPct: z.number().min(0).max(1000).default(5),
  /** Both quotes must have been confirmed within this many ms of each other. */
  maxQuoteSkewMs: z.number().min(0).max(600_000).default(3_000),
  /** Compare USDC-quoted (Hyperliquid) with USDT-quoted contracts (the USDT/USDC basis is ignored). */
  allowMixedQuotes: z.boolean().default(true),
  takerFees: z
    .object({
      bybit: fee(DEFAULT_TAKER_FEES.bybit),
      binance: fee(DEFAULT_TAKER_FEES.binance),
      mexc: fee(DEFAULT_TAKER_FEES.mexc),
      hyperliquid: fee(DEFAULT_TAKER_FEES.hyperliquid),
      bitget: fee(DEFAULT_TAKER_FEES.bitget),
      bingx: fee(DEFAULT_TAKER_FEES.bingx),
      gate: fee(DEFAULT_TAKER_FEES.gate),
    })
    .default({ ...DEFAULT_TAKER_FEES }),
});

export const twapSettingsSchema = z.object({
  ...commonSettingsShape,
  confirmSec: z.number().min(0).max(3600).default(0),
  resolveAfterSec: z.number().min(0).max(86_400).default(900),
  cooldownMinutes: z.number().min(0).max(10_080).default(60),
  minUpdateIntervalSec: z.number().min(0).max(86_400).default(300),
  /** Edit the message when the executed volume grew by this much. */
  significantChangePct: z.number().min(0).max(1000).default(50),
  /** Trades of the last N minutes are analysed. */
  windowMinutes: z.number().min(5).max(120).default(30),
  /** Minimum number of similar executions on one side. */
  minSlices: z.number().int().min(3).max(1000).default(10),
  /** The executions must span at least this long. */
  minDurationSec: z.number().min(0).max(86_400).default(180),
  /** Executed volume of the pattern, USD. */
  minNotionalUsd: z.number().min(0).default(25_000),
  /** Executions count as "similar size" within this tolerance, percent. */
  sizeTolerancePct: z.number().min(1).max(100).default(15),
  /** Heuristic patterns below this confidence (0–1) are not reported. */
  minConfidence: z.number().min(0).max(1).default(0.6),
  /** Report Hyperliquid TWAP slices (zero transaction hash) as exchange-confirmed. */
  hyperliquidConfirmed: z.boolean().default(true),
});

export type CommonSettings = z.output<z.ZodObject<typeof commonSettingsShape>>;
export type TwapSettings = z.output<typeof twapSettingsSchema>;
export type SpreadSettings = z.output<typeof spreadSettingsSchema>;
export type FundingSettings = z.output<typeof fundingSettingsSchema>;
export type FairPriceSettings = z.output<typeof fairPriceSettingsSchema>;
export type OpenInterestSettings = z.output<typeof openInterestSettingsSchema>;

/** Settings schema per scanner. Scanners not built yet use the common settings only. */
export const SCANNER_SETTINGS_SCHEMAS: Record<ScannerId, z.ZodObject> = {
  'fair-price': fairPriceSettingsSchema,
  'open-interest': openInterestSettingsSchema,
  funding: fundingSettingsSchema,
  spread: spreadSettingsSchema,
  twap: twapSettingsSchema,
};

/**
 * JSON Schema of a scanner's settings (types, bounds, enums), so a client can build a form
 * without copying the rules. Validation still happens on the server with the zod schema.
 */
export function settingsJsonSchema(scanner: ScannerId): Record<string, unknown> {
  return z.toJSONSchema(SCANNER_SETTINGS_SCHEMAS[scanner], { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Applies a partial settings update: nested objects (OI `thresholds`, spread `takerFees`) are
 * merged key by key, so submitting one threshold keeps the others; arrays and scalars replace.
 */
export function mergeSettings(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const base = out[key];
    out[key] = isPlainObject(base) && isPlainObject(value) ? mergeSettings(base, value) : value;
  }
  return out;
}

export function defaultSettings(scanner: ScannerId): Record<string, unknown> {
  return SCANNER_SETTINGS_SCHEMAS[scanner].parse({}) as Record<string, unknown>;
}

/**
 * Validates stored or submitted settings. Unknown keys are dropped; missing keys get defaults.
 * Returns the problems (key: message) instead of throwing, so callers can report them.
 */
export function parseScannerSettings(
  scanner: ScannerId,
  raw: unknown,
): { ok: true; settings: Record<string, unknown> } | { ok: false; problems: string[] } {
  const result = SCANNER_SETTINGS_SCHEMAS[scanner].safeParse(raw ?? {});
  if (result.success) return { ok: true, settings: result.data as Record<string, unknown> };
  return {
    ok: false,
    problems: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
