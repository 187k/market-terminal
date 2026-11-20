import { applyLastPrice, spreadPct, summarizeCandles } from '@mip/analytics';
import {
  readInstruments,
  readMarketSnapshots,
  readRestPauses,
  withReaderFreshness,
  writeRestPause,
  type Redis,
  type StoredInstruments,
} from '@mip/bus';
import {
  isZeroHash,
  KLINE_NOTES,
  pauseSharedLimiter,
  type KlineQuery,
  type OrderBook,
} from '@mip/connectors';
import {
  CANDLE_INTERVAL_MS,
  EXCHANGE_IDS,
  type Candle,
  type CandleInterval,
  type CandlesResponse,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type InstrumentInfo,
  type Logger,
  type TerminalBook,
  type TerminalLiveResponse,
  type TerminalStats24h,
  type TerminalTrade,
  type TradeEvent,
} from '@mip/core';

/** Exchange symbols as the connectors produce them (BTCUSDT, BTC_USDT, BTC-USDT, kPEPE). */
export const isInstrumentSymbol = (v: string): boolean => /^[A-Za-z0-9._-]{1,40}$/.test(v);

/** Candles in the live payload: the forming one and the two before it. */
const LIVE_CANDLES = 3;
export const HISTORY_PAGE = 300;
export const BOOK_LEVELS = 20;
export const TRADES_SHOWN = 50;
const STATS_REFRESH_MS = 60_000;
/** After a candle period ends, wait at least this long between syncs for the new candle. */
const ROLLOVER_RETRY_MS = 2_000;
const INSTRUMENTS_CACHE_MS = 10_000;

export interface TerminalSource {
  live(exchange: ExchangeId, symbol: string, interval: CandleInterval): Promise<TerminalLiveResponse>;
  /** Null when the instrument is not tracked. */
  candles(
    exchange: ExchangeId,
    symbol: string,
    interval: CandleInterval,
    q: { limit: number; before?: number },
  ): Promise<CandlesResponse | null>;
}

export interface TerminalDeps {
  /** The exchange's current collector snapshot, or null if it published none. */
  snapshot(exchange: ExchangeId): Promise<ExchangeMarketSnapshot | null>;
  instruments(): Promise<StoredInstruments | null>;
  klines: {
    fetch(exchange: ExchangeId, symbol: string, interval: CandleInterval, q: KlineQuery): Promise<Candle[]>;
  };
  depth: { fetch(exchange: ExchangeId, symbol: string, contractSize: number): Promise<OrderBook> };
  trades: { get(exchange: string, symbol: string): readonly TradeEvent[] };
  tradesSince: () => number | null;
  tradesMinNotional: number;
  bookRefreshMs: number;
  candleSyncMs: number;
  now?: () => number;
}

interface Slot<T> {
  value: T | null;
  /** When `value` was loaded. */
  at: number | null;
  attemptAt: number;
  error: string | null;
  inflight: Promise<void> | null;
}

/**
 * Per-key cache of an exchange request: at most one request in flight per key, and none
 * before `minGapMs` has passed since the last attempt, failed or not. A failing exchange is
 * therefore asked again only at the normal refresh rate, never on every read.
 */
class Throttle<T> {
  readonly #slots = new Map<string, Slot<T>>();

  async get(
    key: string,
    now: number,
    due: (s: Slot<T>) => boolean,
    load: () => Promise<T>,
  ): Promise<Slot<T>> {
    let slot = this.#slots.get(key);
    if (!slot) {
      if (this.#slots.size > 500) this.#slots.clear(); // bounded: keys people viewed recently
      slot = { value: null, at: null, attemptAt: 0, error: null, inflight: null };
      this.#slots.set(key, slot);
    }
    const s = slot;
    if (!s.inflight && due(s)) {
      s.attemptAt = now;
      s.inflight = load().then(
        (value) => {
          s.value = value;
          s.at = now;
          s.error = null;
          s.inflight = null;
        },
        (err: unknown) => {
          s.error = err instanceof Error ? err.message : String(err);
          s.inflight = null;
        },
      );
    }
    // Wait only when there is nothing to show yet; otherwise a slow exchange would hold up
    // the live values and trades in the same payload. The previous value carries its own time.
    if (s.inflight && s.at === null && s.error === null) await s.inflight;
    return s;
  }
}

const toTrade = (t: TradeEvent): TerminalTrade => ({
  ts: t.ts,
  price: t.price,
  size: t.size,
  side: t.side,
  ...(t.exchange === 'hyperliquid' && isZeroHash(t.hash) ? { twapSlice: true as const } : {}),
});

export function toTerminalBook(book: OrderBook, levels = BOOK_LEVELS): TerminalBook {
  return {
    bids: book.bids.slice(0, levels),
    asks: book.asks.slice(0, levels),
    ts: book.ts,
    spreadPct: spreadPct(book.bids[0]?.[0], book.asks[0]?.[0]),
  };
}

/**
 * Data for the dashboard's view-only terminal. Live values and trades come from Redis (fed by
 * the collector's WebSocket streams); candles and order books are requested from the
 * exchange's public REST API only while someone views the instrument, at most once per
 * refresh interval per instrument, through the shared rate limiters.
 */
export function createTerminalSource(deps: TerminalDeps): TerminalSource {
  const now = deps.now ?? Date.now;
  const candleCache = new Throttle<Candle[]>();
  const statsCache = new Throttle<Candle[]>();
  const bookCache = new Throttle<OrderBook>();
  let instruments: { at: number; value: StoredInstruments | null } | null = null;

  const instrumentOf = async (exchange: ExchangeId, symbol: string, t: number) => {
    if (!instruments || t - instruments.at >= INSTRUMENTS_CACHE_MS)
      instruments = { at: t, value: await deps.instruments() };
    return instruments.value?.instruments[exchange]?.find((i) => i.symbol === symbol) ?? null;
  };

  const liveCandles = async (inst: InstrumentInfo, interval: CandleInterval, t: number) => {
    const intervalMs = CANDLE_INTERVAL_MS[interval];
    return candleCache.get(
      `${inst.exchange}:${inst.symbol}:${interval}`,
      t,
      (s) => {
        if (t - s.attemptAt >= deps.candleSyncMs) return true;
        // The forming candle's period is over: fetch the exchange's final candle and the new one.
        const last = s.value?.at(-1);
        return last !== undefined && t >= last.openTime + intervalMs && t - s.attemptAt >= ROLLOVER_RETRY_MS;
      },
      () =>
        deps.klines.fetch(inst.exchange, inst.symbol, interval, {
          limit: LIVE_CANDLES,
          contractSize: inst.contractSize,
        }),
    );
  };

  return {
    async live(exchange, symbol, interval) {
      const t = now();
      const [inst, raw] = await Promise.all([instrumentOf(exchange, symbol, t), deps.snapshot(exchange)]);
      const checked = raw ? withReaderFreshness(raw, t) : null;
      const row = checked?.snapshot.rows.find((r) => r.symbol === symbol) ?? null;
      const base: TerminalLiveResponse = {
        exchange,
        symbol,
        interval,
        instrument: inst,
        fields: inst ? (row?.fields ?? null) : null,
        stale: checked?.stale ?? false,
        candles: [],
        candlesSyncedAt: null,
        candlesError: null,
        stats24h: null,
        statsError: null,
        book: null,
        bookError: null,
        trades: [],
        tradesMinNotional: deps.tradesMinNotional,
        tradesSince: deps.tradesSince(),
        notes: [...(KLINE_NOTES[exchange] ?? [])],
        ts: t,
      };
      if (!inst) {
        const reason = `${symbol} is not tracked on ${exchange}; the terminal shows instruments of the monitored universe.`;
        return { ...base, candlesError: reason, statsError: reason, bookError: reason };
      }

      const lastField = base.fields?.last;
      const live = lastField?.available ? lastField : null;
      const [candles, stats, book] = await Promise.all([
        liveCandles(inst, interval, t),
        statsCache.get(
          `${exchange}:${symbol}`,
          t,
          (s) => t - s.attemptAt >= STATS_REFRESH_MS,
          () => deps.klines.fetch(exchange, symbol, '1h', { limit: 24, contractSize: inst.contractSize }),
        ),
        bookCache.get(
          `${exchange}:${symbol}`,
          t,
          (s) => t - s.attemptAt >= deps.bookRefreshMs,
          () => deps.depth.fetch(exchange, symbol, inst.contractSize),
        ),
      ]);

      // Candles are history: older ones stay valid when a sync fails. A failed book is not shown.
      const shown = candles.value
        ? applyLastPrice(candles.value, CANDLE_INTERVAL_MS[interval], live?.value ?? NaN, live?.ts ?? 0)
        : [];
      let stats24h: TerminalStats24h | null = null;
      if (stats.value) {
        const s = summarizeCandles(stats.value, live?.value ?? null);
        if (s)
          stats24h = {
            open: s.open,
            high: s.high,
            low: s.low,
            volume: s.volume,
            turnover: s.turnover,
            changePct: s.changePct,
            hours: s.count,
          };
      }
      const trades = deps.trades.get(exchange, symbol);
      return {
        ...base,
        candles: [...shown],
        candlesSyncedAt: candles.at,
        candlesError: candles.error,
        stats24h,
        statsError: stats.error,
        book: book.value && !book.error ? toTerminalBook(book.value) : null,
        bookError: book.error,
        trades: trades.slice(-TRADES_SHOWN).reverse().map(toTrade),
      };
    },

    async candles(exchange, symbol, interval, q) {
      const t = now();
      const inst = await instrumentOf(exchange, symbol, t);
      if (!inst) return null;
      const candles = await deps.klines.fetch(exchange, symbol, interval, {
        limit: q.limit,
        contractSize: inst.contractSize,
        ...(q.before !== undefined ? { before: q.before } : {}),
      });
      return { exchange, symbol, interval, candles, fetchedAt: t };
    },
  };
}

/** Builds the Redis-backed parts of TerminalDeps. */
export function redisTerminalReaders(redis: Redis): Pick<TerminalDeps, 'snapshot' | 'instruments'> {
  return {
    snapshot: async (exchange) => (await readMarketSnapshots(redis, [exchange]))[0] ?? null,
    instruments: () => readInstruments(redis),
  };
}

/**
 * Bans are per IP and shared by every process: honour the pauses the collector and engine
 * recorded, and record the ones the terminal's own requests ran into. Same rule as the engine.
 */
export function startBanSync(
  redis: Redis,
  pausedUntil: ((exchange: ExchangeId) => number | null)[],
  logger: Logger,
  everyMs = 5_000,
): () => void {
  let failing = false;
  const sync = async () => {
    try {
      const pauses = await readRestPauses(redis, EXCHANGE_IDS);
      for (const [exchange, until] of Object.entries(pauses))
        pauseSharedLimiter(`${exchange}/rest`, until as number);
      for (const exchange of EXCHANGE_IDS) {
        const until = Math.max(0, ...pausedUntil.map((f) => f(exchange) ?? 0));
        if (until > Date.now()) await writeRestPause(redis, exchange, until);
      }
      failing = false;
    } catch (err) {
      if (!failing) logger.warn({ err: (err as Error).message }, 'syncing exchange bans failed');
      failing = true;
    }
  };
  void sync();
  const timer = setInterval(() => void sync(), everyMs);
  return () => clearInterval(timer);
}
