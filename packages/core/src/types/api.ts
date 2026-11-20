import type { ExchangeId } from './exchanges.js';
import type { ConnectorHealth, ProcessName } from './health.js';
import type {
  ExchangeCapabilities,
  InstrumentInfo,
  MarketRow,
  UniverseAsset,
  UniverseInfo,
} from './market.js';
import type { SignalDto } from './signals.js';

/** Contracts between the API server and the web dashboard. */

export interface ProcessStatus {
  name: ProcessName;
  alive: boolean;
  pid: number | null;
  version: string | null;
  startedAt: number | null;
  lastSeenAt: number | null;
}

export interface SystemStatus {
  serverTime: number;
  processes: ProcessStatus[];
  exchanges: ConnectorHealth[];
  /** When the collector last published exchange health; null if it never did. */
  exchangesUpdatedAt: number | null;
}

export interface ConnectionEventDto {
  id: string;
  at: string;
  exchange: string;
  connection: string;
  state: string;
  reason: string | null;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: boolean;
  redis: boolean;
}

export interface MarketTableRow extends MarketRow {
  assetId: string | null;
  /** Rank of the asset within the universe (1 = largest). */
  assetRank: number | null;
  instrument: InstrumentInfo | null;
}

export interface MarketsResponse {
  exchange: ExchangeId;
  /** When the collector evaluated these values; null if it has published nothing. */
  ts: number | null;
  /** The collector stopped publishing; every value is then reported as stale. */
  stale: boolean;
  rows: MarketTableRow[];
  capabilities: ExchangeCapabilities | null;
}

export interface UniverseResponse {
  universe: UniverseInfo | null;
}

export interface SessionUser {
  username: string;
}

export interface ApiError {
  error: string;
  message: string;
}

/** Active and recently resolved signals of every scanner, from the engine's live state. */
export interface LiveSignalsResponse {
  /** Newest first. */
  active: SignalDto[];
  /** Recently resolved, newest first; at most `LIVE_RECENT_PER_SCANNER` per scanner. */
  recent: SignalDto[];
  /** When the engine last published signals; null if it never did. */
  updatedAt: number | null;
}

/** Resolved signals per scanner included in `LiveSignalsResponse.recent`. */
export const LIVE_RECENT_PER_SCANNER = 20;

/** One exchange's instrument for an asset, with its current values. */
export interface AssetMarketRow extends MarketTableRow {
  exchange: ExchangeId;
}

/** A minute snapshot as stored by the collector; null = the value was missing or stale then. */
export interface AssetHistoryPoint {
  ts: number;
  mark: number | null;
  openInterest: number | null;
  fundingRate: number | null;
}

export interface AssetHistorySeries {
  exchange: ExchangeId;
  symbol: string;
  points: AssetHistoryPoint[];
}

/** Everything known about one asset across exchanges (dashboard coin view). */
export interface AssetDetailResponse {
  /** Asset code, e.g. "PEPE" (what signals use in `asset`). */
  asset: string;
  /** The universe entry, when the asset is in the monitored universe. */
  universe: UniverseAsset | null;
  /** The asset's instruments on each exchange, with current values. */
  rows: AssetMarketRow[];
  /** Exchanges whose collector snapshot is too old; their values are reported as stale. */
  staleExchanges: ExchangeId[];
  capabilities: Partial<Record<ExchangeId, ExchangeCapabilities>>;
  /** Open signals of every scanner for this asset, newest first. */
  active: SignalDto[];
  /** Resolved signals for this asset, newest first. */
  recent: SignalDto[];
  /** Minute snapshots of the last `historyHours`, one point every `historyStepMinutes`. */
  history: AssetHistorySeries[];
  historyHours: number;
  historyStepMinutes: number;
  ts: number;
}

/**
 * Realtime topics on `/ws`. Each delivers the same payload as its REST endpoint:
 * status → SystemStatus, scanners → ScannersResponse, signals → LiveSignalsResponse,
 * events → ConnectionEventDto[], markets:<exchange> → MarketsResponse,
 * asset:<code> → AssetDetailResponse,
 * terminal:<exchange>:<symbol>:<interval> → TerminalLiveResponse,
 * overview → MarketOverviewResponse, perps → PerpOverviewResponse.
 */
export type RealtimeTopic =
  | 'status'
  | 'scanners'
  | 'signals'
  | 'events'
  | 'overview'
  | 'perps'
  | `markets:${ExchangeId}`
  | `asset:${string}`
  | `terminal:${ExchangeId}:${string}:${string}`;

export type RealtimeClientMessage =
  { type: 'subscribe'; topics: string[] } | { type: 'unsubscribe'; topics: string[] };

export type RealtimeServerMessage =
  | { type: 'hello'; serverTime: number }
  | { type: 'data'; topic: string; data: unknown }
  | { type: 'error'; topic: string | null; message: string };

/** WebSocket close code sent when the session is missing or expired. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
