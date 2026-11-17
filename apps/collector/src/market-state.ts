import {
  available,
  MARKET_FIELDS,
  unavailable,
  type ExchangeCapabilities,
  type ExchangeDataHealth,
  type ExchangeId,
  type ExchangeMarketSnapshot,
  type Field,
  type MarketField,
  type MarketRow,
  type MarketUpdate,
  type Now,
} from '@mip/core';

interface RawField {
  value: number;
  /** Local time the value was received. */
  ts: number;
  /** Exchange event time, for discarding out-of-order updates. */
  exTs: number | null;
  /** Delivering WebSocket connection, or null for REST. */
  conn: string | null;
}

interface Row {
  fields: Partial<Record<MarketField, RawField>>;
  invalid: Partial<Record<MarketField, { detail: string; ts: number }>>;
  /**
   * Last message for this symbol per WebSocket connection. On a change-only stream it confirms
   * that values it did not resend are unchanged. Kept per connection so that one busy stream
   * (e.g. Binance mark price) cannot vouch for another, silent one (its book stream).
   */
  seenAt: Record<string, number>;
}

interface Book {
  caps: ExchangeCapabilities;
  rows: Map<string, Row>;
  /** Connection name -> time it last stopped being open. */
  interrupted: Map<string, number>;
  instruments: number;
  updates: number;
  invalid: number;
  latency: number | null;
  lastUpdateAt: number | null;
  rate: { at: number; updates: number; perSec: number };
}

const PRICE_FIELDS = new Set<MarketField>(['last', 'mark', 'index', 'bid', 'ask']);
const NON_NEGATIVE = new Set<MarketField>(['bidSize', 'askSize', 'openInterest', 'turnover24h']);

/** How long a REST snapshot may stand in for a stream field whose stream is not delivering. */
export const REST_SNAPSHOT_MAX_AGE_MS = 30_000;

/** Funding rates beyond ±10 % per interval are treated as corrupt input, not as extreme markets. */
const MAX_ABS_FUNDING = 0.1;

/** Returns a reason when a value is implausible for its field, else null. */
export function validate(field: MarketField, value: number, now: number): string | null {
  if (!Number.isFinite(value)) return 'not a finite number';
  if (PRICE_FIELDS.has(field)) return value > 0 ? null : `price must be > 0 (got ${value})`;
  if (NON_NEGATIVE.has(field)) return value >= 0 ? null : `must be >= 0 (got ${value})`;
  switch (field) {
    case 'fundingRate':
      return Math.abs(value) <= MAX_ABS_FUNDING ? null : `|rate| > ${MAX_ABS_FUNDING} (got ${value})`;
    case 'fundingIntervalHours':
      return value > 0 && value <= 24 ? null : `interval must be in (0, 24] h (got ${value})`;
    case 'nextFundingTime':
      return value > now - 6 * 3_600_000 && value < now + 7 * 86_400_000
        ? null
        : `time out of range (${new Date(value).toISOString()})`;
    default:
      return null;
  }
}

/**
 * The collector's in-memory view of every tracked instrument. Applies normalised updates
 * (validated, out-of-order ones dropped) and evaluates each field's freshness on read:
 *
 * - a value from a connection that went down after the value arrived is `stale`;
 * - `change` fields stay valid while messages for that symbol keep arriving;
 * - `interval` fields go stale when not refreshed within `maxAgeMs`.
 */
export class MarketState {
  readonly #books = new Map<ExchangeId, Book>();
  readonly #now: Now;

  constructor(now: Now = Date.now) {
    this.#now = now;
  }

  register(exchange: ExchangeId, caps: ExchangeCapabilities): void {
    if (this.#books.has(exchange)) {
      this.#books.get(exchange)!.caps = caps;
      return;
    }
    this.#books.set(exchange, {
      caps,
      rows: new Map(),
      interrupted: new Map(),
      instruments: 0,
      updates: 0,
      invalid: 0,
      latency: null,
      lastUpdateAt: null,
      rate: { at: this.#now(), updates: 0, perSec: 0 },
    });
  }

  exchanges(): ExchangeId[] {
    return [...this.#books.keys()];
  }

  setInstrumentCount(exchange: ExchangeId, count: number): void {
    const book = this.#books.get(exchange);
    if (book) book.instruments = count;
  }

  /** Only tracked symbols are kept; rows of removed symbols are dropped. */
  setTracked(exchange: ExchangeId, symbols: readonly string[]): void {
    const book = this.#books.get(exchange);
    if (!book) throw new Error(`exchange ${exchange} not registered`);
    const wanted = new Set(symbols);
    for (const s of book.rows.keys()) if (!wanted.has(s)) book.rows.delete(s);
    for (const s of wanted) if (!book.rows.has(s)) book.rows.set(s, { fields: {}, invalid: {}, seenAt: {} });
  }

  tracked(exchange: ExchangeId): string[] {
    return [...(this.#books.get(exchange)?.rows.keys() ?? [])];
  }

  apply(exchange: ExchangeId, u: MarketUpdate): void {
    const book = this.#books.get(exchange);
    const row = book?.rows.get(u.symbol);
    if (!book || !row) return;
    book.updates++;
    book.lastUpdateAt = u.receivedAt;
    if (u.connection) {
      row.seenAt[u.connection] = u.receivedAt;
      if (u.exchangeTs !== null) {
        const delay = u.receivedAt - u.exchangeTs;
        book.latency = book.latency === null ? delay : book.latency * 0.98 + delay * 0.02;
      }
    }
    for (const key in u.values) {
      const field = key as MarketField;
      const value = u.values[field]!;
      const prev = row.fields[field];
      // Timestamps are only comparable within one stream: a REST response is stamped with the
      // response time, a WS snapshot with the time the value last changed. Comparing across
      // sources would discard a fresh snapshot as "older" (seen live on quiet Bybit symbols).
      if (
        prev &&
        prev.conn === u.connection &&
        u.exchangeTs !== null &&
        prev.exTs !== null &&
        u.exchangeTs < prev.exTs
      )
        continue;
      // A REST snapshot (bootstrap, periodic re-sync) only fills gaps in fields a WebSocket
      // maintains: it must not take over a field whose stream is still up. Otherwise a value
      // that rarely changes (funding interval) is relabelled as REST data and ages out, because
      // change-only streams do not resend it (seen live on Bybit after the 15-min re-sync).
      if (u.connection === null && prev?.conn && book.caps[field].source === 'ws') {
        const down = book.interrupted.get(prev.conn);
        if (down === undefined || down < prev.ts) continue;
      }
      const problem = validate(field, value, u.receivedAt);
      if (problem) {
        book.invalid++;
        row.invalid[field] = { detail: problem, ts: u.receivedAt };
        delete row.fields[field];
        continue;
      }
      if (row.invalid[field]) delete row.invalid[field];
      if (prev) {
        prev.value = value;
        prev.ts = u.receivedAt;
        prev.exTs = u.exchangeTs;
        prev.conn = u.connection;
      } else {
        row.fields[field] = { value, ts: u.receivedAt, exTs: u.exchangeTs, conn: u.connection };
      }
    }
  }

  /** A connection stopped being open: values it delivered are stale until refreshed. */
  connectionDown(exchange: ExchangeId, connection: string, at: number): void {
    this.#books.get(exchange)?.interrupted.set(connection, at);
  }

  field(exchange: ExchangeId, symbol: string, field: MarketField, now = this.#now()): Field<number> {
    const book = this.#books.get(exchange);
    const row = book?.rows.get(symbol);
    if (!book || !row) return unavailable('not_received', 'instrument not tracked');
    return this.#evaluate(book, row, field, now);
  }

  snapshot(exchange: ExchangeId, now = this.#now()): ExchangeMarketSnapshot {
    const book = this.#books.get(exchange);
    const rows: MarketRow[] = [];
    if (book) {
      for (const [symbol, row] of book.rows) {
        const fields = {} as Record<MarketField, Field<number>>;
        for (const f of MARKET_FIELDS) fields[f] = this.#evaluate(book, row, f, now);
        rows.push({ symbol, fields });
      }
    }
    return { exchange, ts: now, rows };
  }

  dataHealth(exchange: ExchangeId, now = this.#now()): ExchangeDataHealth | null {
    const book = this.#books.get(exchange);
    if (!book) return null;
    let fresh = 0;
    for (const row of book.rows.values()) {
      if ((['mark', 'bid', 'ask'] as const).every((f) => this.#evaluate(book, row, f, now).available))
        fresh++;
    }
    // Averaged over 10 s: some exchanges deliver in bursts (MEXC tickers every 2–3 s).
    const elapsed = now - book.rate.at;
    if (elapsed >= 10_000) {
      book.rate = {
        at: now,
        updates: book.updates,
        perSec: ((book.updates - book.rate.updates) * 1000) / elapsed,
      };
    }
    return {
      instruments: book.instruments,
      tracked: book.rows.size,
      fresh,
      updatesPerSec: Math.round(book.rate.perSec),
      invalid: book.invalid,
      latencyMs: book.latency === null ? null : Math.round(book.latency),
      lastUpdateAt: book.lastUpdateAt,
    };
  }

  #evaluate(book: Book, row: Row, field: MarketField, now: number): Field<number> {
    const cap = book.caps[field];
    const raw = row.fields[field];
    const bad = row.invalid[field];
    if (bad) return unavailable('invalid', bad.detail);
    if (!raw) {
      if (cap.source === 'none') return unavailable(cap.reason ?? 'not_provided', cap.note);
      return unavailable('not_received');
    }
    if (raw.conn !== null) {
      const down = book.interrupted.get(raw.conn);
      if (down !== undefined && down >= raw.ts) return unavailable('stale', 'connection interrupted');
    }
    const confirmedAt =
      cap.refresh === 'change' && raw.conn !== null ? Math.max(raw.ts, row.seenAt[raw.conn] ?? 0) : raw.ts;
    const age = now - confirmedAt;
    // A stream field that so far only has a one-off REST value (bootstrap or re-sync, stream not
    // delivering) is a snapshot, not a live value: it gets a short life of its own.
    const maxAge =
      cap.source === 'ws' && raw.conn === null
        ? Math.min(cap.maxAgeMs ?? REST_SNAPSHOT_MAX_AGE_MS, REST_SNAPSHOT_MAX_AGE_MS)
        : cap.maxAgeMs;
    if (maxAge !== undefined && age > maxAge) {
      return unavailable(
        'stale',
        raw.conn === null && cap.source === 'ws'
          ? `only a REST snapshot from ${Math.round(age / 1000)} s ago; the stream is not delivering`
          : `no update for ${Math.round(age / 1000)} s`,
      );
    }
    return available(raw.value, confirmedAt);
  }
}
