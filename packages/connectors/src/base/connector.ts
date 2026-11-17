import { EventEmitter } from 'node:events';
import type {
  ConnectionStateEvent,
  ConnectorHealth,
  ConnectorState,
  ExchangeCapabilities,
  ExchangeId,
  InstrumentInfo,
  Logger,
  MarketsBootstrap,
  MarketUpdate,
  TradeEvent,
} from '@mip/core';
import type { RestClient } from './rest-client.js';
import type { SubscriptionManager } from './subscriptions.js';

export type ConnectorEvents = {
  connection: [ConnectionStateEvent];
};

/** Receives normalised data from connectors. Called synchronously on the hot path; keep it cheap. */
export interface MarketSink {
  market(exchange: ExchangeId, update: MarketUpdate): void;
  instruments(exchange: ExchangeId, list: InstrumentInfo[]): void;
  /** Public trades of tracked symbols (optional: connectors skip trade work without it). */
  trade?(trade: TradeEvent): void;
}

/** Read-only API credentials for one exchange (optional; used only for endpoints that require a key). */
export interface Credentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

/** Host overrides (e.g. a regional mirror); connectors use their documented hosts otherwise. */
export interface Endpoints {
  restUrl?: string;
  wsUrl?: string;
}

export interface ConnectorContext {
  logger: Logger;
  sink: MarketSink;
  credentials?: Credentials;
  endpoints?: Endpoints;
}

export interface ExchangeConnector {
  readonly exchange: ExchangeId;
  /** Which fields this exchange provides and how; used for freshness and "unavailable" reasons. */
  readonly capabilities: ExchangeCapabilities;
  /** Loads tradable crypto perpetuals plus a REST snapshot of their current values. */
  loadMarkets(): Promise<MarketsBootstrap>;
  /** Sets the symbols to stream. May be called before or after start(). */
  setTracked(symbols: readonly string[]): void;
  tracked(): string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): ConnectorHealth;
  on<K extends keyof ConnectorEvents>(event: K, listener: (...args: ConnectorEvents[K]) => void): this;
  off<K extends keyof ConnectorEvents>(event: K, listener: (...args: ConnectorEvents[K]) => void): this;
}

export type ConnectorFactory = (ctx: ConnectorContext) => ExchangeConnector;

interface Task {
  name: string;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

/** Instruments (and REST-only fields) are reloaded this often to catch listings, delistings and interval changes. */
export const INSTRUMENT_REFRESH_MS = 15 * 60_000;

/**
 * Shared plumbing for concrete connectors: tracked-symbol bookkeeping, periodic REST tasks,
 * health aggregation of streams and REST, and forwarding of connection state changes.
 */
export abstract class BaseConnector extends EventEmitter<ConnectorEvents> implements ExchangeConnector {
  abstract readonly exchange: ExchangeId;
  abstract readonly capabilities: ExchangeCapabilities;
  protected readonly log: Logger;
  protected readonly sink: MarketSink;
  protected readonly credentials: Credentials | undefined;
  readonly #streams: SubscriptionManager[] = [];
  readonly #tasks: Task[] = [];
  #rest: RestClient | null = null;
  #tracked = new Set<string>();
  #lifecycle: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  #detail: string | null = null;

  protected constructor(ctx: ConnectorContext, exchange: ExchangeId) {
    super();
    this.log = ctx.logger.child({ exchange });
    this.sink = ctx.sink;
    this.credentials = ctx.credentials;
  }

  abstract loadMarkets(): Promise<MarketsBootstrap>;

  /** Start streams and pollers for the tracked symbols. */
  protected abstract onStart(): Promise<void>;
  /** Called after setTracked() while running. */
  protected abstract onTrackedChanged(added: string[], removed: string[]): void;
  protected async onStop(): Promise<void> {}

  get running(): boolean {
    return this.#lifecycle === 'running';
  }

  protected get stopped(): boolean {
    return this.#lifecycle === 'stopped';
  }

  tracked(): string[] {
    return [...this.#tracked];
  }

  setTracked(symbols: readonly string[]): void {
    const next = new Set(symbols);
    const added = [...next].filter((s) => !this.#tracked.has(s));
    const removed = [...this.#tracked].filter((s) => !next.has(s));
    this.#tracked = next;
    if (this.#lifecycle === 'running' && (added.length > 0 || removed.length > 0)) {
      this.log.info({ added: added.length, removed: removed.length }, 'tracked symbols changed');
      this.onTrackedChanged(added, removed);
    }
  }

  protected isTracked(symbol: string): boolean {
    return this.#tracked.has(symbol);
  }

  async start(): Promise<void> {
    if (this.#lifecycle === 'starting' || this.#lifecycle === 'running') return;
    this.#lifecycle = 'starting';
    try {
      await this.onStart();
      this.#lifecycle = 'running';
      this.every('instruments', INSTRUMENT_REFRESH_MS, () => this.refreshMarkets());
    } catch (err) {
      this.#lifecycle = 'stopped';
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const t of this.#tasks) {
      t.running = false;
      if (t.timer) clearTimeout(t.timer);
    }
    this.#tasks.length = 0;
    await this.onStop();
    await Promise.all(this.#streams.map((s) => s.stop()));
    this.#lifecycle = 'stopped';
  }

  health(): ConnectorHealth {
    const connections = this.#streams.flatMap((s) => s.health());
    return {
      exchange: this.exchange,
      state: this.#deriveState(connections.map((c) => c.state)),
      detail: this.#detail,
      connections,
      rest: this.#rest?.health() ?? null,
      updatedAt: Date.now(),
    };
  }

  /** Test / ops hook: cuts all WebSocket connections as a network failure would; they reconnect. */
  dropConnections(reason = 'dropped on request'): void {
    for (const s of this.#streams) s.dropAll(reason);
  }

  /** Reloads instruments and the REST snapshot; forwards both to the sink. */
  protected async refreshMarkets(): Promise<void> {
    const boot = await this.loadMarkets();
    this.sink.instruments(this.exchange, boot.instruments);
    const listed = new Set(boot.instruments.map((i) => i.symbol));
    const gone = this.tracked().filter((s) => !listed.has(s));
    if (gone.length > 0) {
      this.log.warn({ symbols: gone }, 'tracked instruments are no longer tradable; unsubscribing');
      this.setTracked(this.tracked().filter((s) => listed.has(s)));
    }
    for (const u of boot.updates) if (this.isTracked(u.symbol)) this.sink.market(this.exchange, u);
  }

  protected push(update: MarketUpdate): void {
    this.sink.market(this.exchange, update);
  }

  /** Whether to subscribe to public trades (only when someone consumes them). */
  protected get wantsTrades(): boolean {
    return this.sink.trade !== undefined;
  }

  protected pushTrade(trade: TradeEvent): void {
    this.sink.trade?.(trade);
  }

  /**
   * Runs `task` every `intervalMs` (the next run is scheduled after the previous one finishes,
   * so slow requests never pile up). Errors are logged and do not stop the schedule.
   */
  protected every(
    name: string,
    intervalMs: number,
    task: () => Promise<void>,
    options: { runNow?: boolean } = {},
  ): void {
    const entry: Task = { name, timer: null, running: true };
    this.#tasks.push(entry);
    const run = async () => {
      if (!entry.running) return;
      try {
        await task();
      } catch (err) {
        this.log.warn({ task: name, err: (err as Error).message }, 'periodic task failed');
      }
      if (entry.running) entry.timer = setTimeout(() => void run(), intervalMs);
    };
    if (options.runNow) void run();
    else entry.timer = setTimeout(() => void run(), intervalMs);
  }

  protected registerStream(stream: SubscriptionManager): SubscriptionManager {
    this.#streams.push(stream);
    stream.on('state', (s) =>
      this.emit('connection', {
        exchange: this.exchange,
        connection: s.connection,
        state: s.state,
        reason: s.reason,
        at: s.at,
      }),
    );
    return stream;
  }

  protected registerRest(client: RestClient): RestClient {
    this.#rest = client;
    return client;
  }

  protected setDetail(detail: string | null): void {
    this.#detail = detail;
  }

  #deriveState(states: string[]): ConnectorState {
    if (this.#lifecycle === 'idle' || this.#lifecycle === 'starting') return 'starting';
    if (this.#lifecycle === 'stopped') return 'stopped';
    if (states.length === 0) return 'ok'; // REST-only connector
    const open = states.filter((s) => s === 'open').length;
    if (open === states.length) return 'ok';
    return open === 0 ? 'down' : 'degraded';
  }
}
