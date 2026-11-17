import type { ExchangeId } from './exchanges.js';
import type { ExchangeDataHealth } from './market.js';

/** Lifecycle of a single managed WebSocket connection. */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface ConnectionHealth {
  /** Stable name, e.g. "bybit/linear#0". */
  name: string;
  url: string;
  state: ConnectionState;
  /** Number of topics currently assigned to this connection. */
  topics: number;
  connectedAt: number | null;
  lastMessageAt: number | null;
  messages: number;
  reconnects: number;
  lastError: string | null;
  /** Reason given for the last state change (e.g. "stale: no data for 30000 ms"). */
  lastReason: string | null;
  lastStateChangeAt: number;
}

export interface RestHealth {
  requests: number;
  errors: number;
  rateLimited: number;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Requests are held back until this time after a 429 / ban; null when not paused. */
  pausedUntil: number | null;
  avgLatencyMs: number | null;
}

export type ConnectorState =
  /** No connector exists yet for this exchange. */
  | 'not_implemented'
  /** Switched off by configuration. */
  | 'disabled'
  | 'starting'
  | 'ok'
  /** Running, but some connections are down or data is stale. */
  | 'degraded'
  | 'down'
  | 'stopped';

export interface ConnectorHealth {
  exchange: ExchangeId;
  state: ConnectorState;
  detail: string | null;
  connections: ConnectionHealth[];
  rest: RestHealth | null;
  /** Data quality, filled in by the collector from the live market state. */
  data?: ExchangeDataHealth | null;
  updatedAt: number;
}

/** A connection state transition, persisted and shown in the dashboard. */
export interface ConnectionStateEvent {
  exchange: ExchangeId;
  connection: string;
  state: ConnectionState | 'error';
  reason: string | null;
  at: number;
}

export const PROCESS_NAMES = ['collector', 'engine', 'api'] as const;
export type ProcessName = (typeof PROCESS_NAMES)[number];

export interface ProcessHeartbeat {
  name: ProcessName;
  pid: number;
  version: string;
  startedAt: number;
  ts: number;
}
