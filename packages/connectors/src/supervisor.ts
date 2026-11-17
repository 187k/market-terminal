import { EventEmitter } from 'node:events';
import {
  EXCHANGE_IDS,
  type ConnectionStateEvent,
  type ConnectorHealth,
  type ExchangeId,
  type Logger,
  type MarketsBootstrap,
} from '@mip/core';
import type {
  ConnectorFactory,
  Credentials,
  Endpoints,
  ExchangeConnector,
  MarketSink,
} from './base/connector.js';
import { ExchangeApiError } from './base/errors.js';

export interface SupervisorOptions {
  enabled: readonly ExchangeId[];
  factories: Partial<Record<ExchangeId, ConnectorFactory>>;
  logger: Logger;
  sink: MarketSink;
  credentials?: Partial<Record<ExchangeId, Credentials>>;
  endpoints?: Partial<Record<ExchangeId, Endpoints>>;
  /**
   * Decides which symbols to stream once an exchange's markets are loaded (the collector waits
   * for the universe here). Defaults to every instrument.
   */
  selectSymbols?: (exchange: ExchangeId, boot: MarketsBootstrap) => Promise<string[]>;
  /** Told when an exchange could not be loaded, so nobody waits for it. */
  onLoadFailed?: (exchange: ExchangeId, error: string) => void;
  /** Delay before retrying a connector whose start failed. */
  restartDelayMs?: number;
}

type Events = { connection: [ConnectionStateEvent] };

interface Slot {
  exchange: ExchangeId;
  connector: ExchangeConnector | null;
  phase: 'loading' | 'selecting' | 'starting' | 'running' | 'failed';
  failure: string | null;
  failedAt: number | null;
  retryTimer: NodeJS.Timeout | null;
}

/**
 * Owns all exchange connectors: load markets -> select symbols -> stream. A connector that
 * fails at any step is isolated and retried; it never takes the other exchanges down with it.
 */
export class ConnectorSupervisor extends EventEmitter<Events> {
  readonly #opts: SupervisorOptions;
  readonly #log: Logger;
  readonly #slots = new Map<ExchangeId, Slot>();
  #stopping = false;

  constructor(options: SupervisorOptions) {
    super();
    this.#opts = options;
    this.#log = options.logger.child({ component: 'supervisor' });
  }

  /** Exchanges that are enabled and have a connector implementation. */
  get startable(): ExchangeId[] {
    return this.#opts.enabled.filter((id) => this.#opts.factories[id]);
  }

  async start(): Promise<void> {
    this.#stopping = false;
    const missing = this.#opts.enabled.filter((id) => !this.#opts.factories[id]);
    if (missing.length > 0)
      this.#log.warn({ exchanges: missing }, 'no connector implemented yet for these exchanges');
    await Promise.all(this.startable.map((id) => this.#startOne(id)));
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.all(
      [...this.#slots.values()].map(async (slot) => {
        if (slot.retryTimer) clearTimeout(slot.retryTimer);
        await slot.connector
          ?.stop()
          .catch((err: unknown) => this.#log.error({ err, exchange: slot.exchange }, 'stop failed'));
      }),
    );
  }

  /** Changes the streamed symbols of a running (or starting) connector. */
  setTracked(exchange: ExchangeId, symbols: readonly string[]): void {
    this.#slots.get(exchange)?.connector?.setTracked(symbols);
  }

  connector(exchange: ExchangeId): ExchangeConnector | null {
    return this.#slots.get(exchange)?.connector ?? null;
  }

  /** Health of every known exchange, in display order. */
  health(): ConnectorHealth[] {
    const now = Date.now();
    return EXCHANGE_IDS.map((exchange): ConnectorHealth => {
      const base = { exchange, connections: [], rest: null, updatedAt: now };
      if (!this.#opts.enabled.includes(exchange))
        return { ...base, state: 'disabled', detail: 'disabled in EXCHANGES_ENABLED' };
      if (!this.#opts.factories[exchange])
        return { ...base, state: 'not_implemented', detail: 'connector not implemented yet' };
      const slot = this.#slots.get(exchange);
      if (slot?.failure) return { ...base, state: 'down', detail: slot.failure };
      if (!slot?.connector || slot.phase !== 'running') {
        const rest = slot?.connector?.health().rest ?? null;
        const paused = rest?.pausedUntil && rest.pausedUntil > now ? rest.pausedUntil : null;
        const detail =
          slot?.phase === 'loading'
            ? paused
              ? `waiting for the exchange's ban / rate limit to end (${new Date(paused).toISOString().slice(11, 16)} UTC) before loading instruments`
              : 'loading instruments'
            : slot?.phase === 'selecting'
              ? 'waiting for the instrument universe'
              : null;
        return { ...base, state: 'starting', rest, detail };
      }
      return slot.connector.health();
    });
  }

  async #startOne(exchange: ExchangeId): Promise<void> {
    const factory = this.#opts.factories[exchange];
    if (!factory || this.#stopping) return;
    const slot: Slot = this.#slots.get(exchange) ?? {
      exchange,
      connector: null,
      phase: 'loading',
      failure: null,
      failedAt: null,
      retryTimer: null,
    };
    this.#slots.set(exchange, slot);
    slot.phase = 'loading';
    let step = 'load markets';
    try {
      const credentials = this.#opts.credentials?.[exchange];
      const endpoints = this.#opts.endpoints?.[exchange];
      const connector = factory({
        logger: this.#opts.logger,
        sink: this.#opts.sink,
        ...(credentials ? { credentials } : {}),
        ...(endpoints ? { endpoints } : {}),
      });
      connector.on('connection', (e) => this.emit('connection', e));
      slot.connector = connector;

      const boot = await connector.loadMarkets();
      this.#opts.sink.instruments(exchange, boot.instruments);
      this.#log.info({ exchange, instruments: boot.instruments.length }, 'markets loaded');

      step = 'select symbols';
      slot.phase = 'selecting';
      const symbols = this.#opts.selectSymbols
        ? await this.#opts.selectSymbols(exchange, boot)
        : boot.instruments.map((i) => i.symbol);
      if (this.#stopping) return;
      connector.setTracked(symbols);
      // The REST snapshot seeds the live state before the streams start.
      const tracked = new Set(symbols);
      for (const u of boot.updates) if (tracked.has(u.symbol)) this.#opts.sink.market(exchange, u);

      step = 'start';
      slot.phase = 'starting';
      await connector.start();
      slot.phase = 'running';
      slot.failure = null;
      slot.failedAt = null;
      this.#log.info({ exchange, tracked: symbols.length }, 'connector started');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      slot.phase = 'failed';
      slot.failure = `${step} failed: ${message}`;
      slot.failedAt = Date.now();
      this.#log.error({ exchange, err }, `connector failed (${step})`);
      this.emit('connection', {
        exchange,
        connection: 'connector',
        state: 'error',
        reason: slot.failure,
        at: slot.failedAt,
      });
      if (step === 'load markets') this.#opts.onLoadFailed?.(exchange, message);
      await slot.connector?.stop().catch(() => undefined);
      slot.connector = null;
      if (!this.#stopping) {
        // After a ban or rate limit, wait as long as the exchange asked: retrying earlier
        // prolongs bans (Binance escalates from minutes to days for repeat offenders).
        const throttled =
          err instanceof ExchangeApiError && (err.kind === 'banned' || err.kind === 'rate_limited');
        const hold = throttled ? (err.details.retryAfterMs ?? (err.kind === 'banned' ? 120_000 : 0)) : 0;
        const delay = Math.max(this.#opts.restartDelayMs ?? 30_000, hold);
        slot.failure += ` (next attempt ${new Date(Date.now() + delay).toISOString().slice(11, 19)} UTC)`;
        slot.retryTimer = setTimeout(() => {
          slot.retryTimer = null;
          void this.#startOne(exchange);
        }, delay);
      }
    }
  }
}
