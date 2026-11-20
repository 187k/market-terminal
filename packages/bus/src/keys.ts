import type { ExchangeId, ProcessName, ScannerId } from '@mip/core';

/** Every Redis key and channel the processes share lives here, so they cannot drift apart. */
const PREFIX = 'mip';

export const KEYS = {
  processHeartbeat: (name: ProcessName) => `${PREFIX}:proc:${name}`,
  exchangeHealth: `${PREFIX}:health:exchanges`,
  session: (id: string) => `${PREFIX}:sess:${id}`,
  /** Evaluated live values of one exchange's tracked instruments (ExchangeMarketSnapshot). */
  market: (exchange: ExchangeId) => `${PREFIX}:market:${exchange}`,
  /** Tracked instruments of every exchange, plus their field capabilities. */
  instruments: `${PREFIX}:instruments`,
  /** Current instrument universe (UniverseInfo). */
  universe: `${PREFIX}:universe`,
  /** Time until which an exchange told us to stop sending REST requests (ban / rate limit). */
  restPause: (exchange: ExchangeId) => `${PREFIX}:pause:${exchange}`,
  /** Active and recently resolved signals of one scanner (published by the engine). */
  signals: (scanner: ScannerId) => `${PREFIX}:signals:${scanner}`,
  /** Status of every scanner (published by the engine). */
  scannerStatus: `${PREFIX}:scanners`,
  /** Redis Stream of public trade batches (collector → engine). */
  trades: `${PREFIX}:trades`,
  /** CoinGecko spot figures and global market stats for the home page (collector → api). */
  marketOverview: `${PREFIX}:overview`,
} as const;

export const CHANNELS = {
  connectionEvents: `${PREFIX}:events:connection`,
  /** Published by the API when scanner settings change; the engine reloads them. */
  settingsChanged: `${PREFIX}:events:settings`,
} as const;
