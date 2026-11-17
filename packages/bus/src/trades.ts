import type { ExchangeId, TradeEvent } from '@mip/core';
import { KEYS } from './keys.js';
import type { Redis } from './redis.js';

/** Compact wire form: [exchange, symbol, ts, price, size, "b"|"s", users | null, hash | null]. */
type WireTrade = [
  ExchangeId,
  string,
  number,
  number,
  number,
  'b' | 's',
  [string, string] | null,
  string | null,
];

/** About 1.4 h of batches at 4 batches / s; older trades are not needed by any scanner. */
export const TRADE_STREAM_MAXLEN = 20_000;

const encode = (t: TradeEvent): WireTrade => [
  t.exchange,
  t.symbol,
  t.ts,
  t.price,
  t.size,
  t.side === 'buy' ? 'b' : 's',
  t.users ?? null,
  t.hash ?? null,
];

const decode = (w: WireTrade): TradeEvent => ({
  exchange: w[0],
  symbol: w[1],
  ts: w[2],
  price: w[3],
  size: w[4],
  side: w[5] === 'b' ? 'buy' : 'sell',
  ...(w[6] ? { users: w[6] } : {}),
  ...(w[7] ? { hash: w[7] } : {}),
});

/** Appends one batch of trades to the trade stream (capped at TRADE_STREAM_MAXLEN batches). */
export async function appendTrades(redis: Redis, trades: TradeEvent[]): Promise<void> {
  if (trades.length === 0) return;
  await redis.xadd(
    KEYS.trades,
    'MAXLEN',
    '~',
    TRADE_STREAM_MAXLEN,
    '*',
    'b',
    JSON.stringify(trades.map(encode)),
  );
}

function decodeEntries(entries: [string, string[]][]): TradeEvent[] {
  const out: TradeEvent[] = [];
  for (const [, fields] of entries) {
    const i = fields.indexOf('b');
    if (i === -1) continue;
    try {
      for (const w of JSON.parse(fields[i + 1]!) as WireTrade[]) out.push(decode(w));
    } catch {
      // a corrupt batch is skipped, never fatal
    }
  }
  return out;
}

/** Trades appended since `sinceMs` (stream ids start with the append time), oldest first. */
export async function readTradesSince(
  redis: Redis,
  sinceMs: number,
): Promise<{ lastId: string; trades: TradeEvent[] }> {
  const entries = (await redis.xrange(KEYS.trades, `${Math.floor(sinceMs)}-0`, '+')) as [string, string[]][];
  return { lastId: entries.at(-1)?.[0] ?? `${Math.floor(sinceMs)}-0`, trades: decodeEntries(entries) };
}

/** Waits up to `blockMs` for trades after `lastId`. Needs a dedicated connection (blocking). */
export async function readNewTrades(
  redis: Redis,
  lastId: string,
  blockMs: number,
): Promise<{ lastId: string; trades: TradeEvent[] }> {
  const res = (await redis.xread('COUNT', 500, 'BLOCK', blockMs, 'STREAMS', KEYS.trades, lastId)) as
    [string, [string, string[]][]][] | null;
  const entries = res?.[0]?.[1] ?? [];
  return { lastId: entries.at(-1)?.[0] ?? lastId, trades: decodeEntries(entries) };
}
