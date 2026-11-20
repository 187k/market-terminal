import type { TerminalBook, TerminalBookLevel, TerminalTrade } from '@mip/core/types';
import { formatClock, formatCompact, formatFixed, formatSize, formatSmallPct } from '../format';

/** Running totals of size from the best level outwards, for the depth bars. */
function withTotals(levels: TerminalBookLevel[]): { price: number; size: number; total: number }[] {
  let total = 0;
  return levels.map(([price, size]) => {
    total += size;
    return { price, size, total };
  });
}

/**
 * Order book of the viewed instrument: asks above (best ask nearest the middle), bids below,
 * with cumulative size bars. Sizes are in base units.
 */
export function OrderBook({
  book,
  error,
  decimals,
  base,
  quote,
  last,
  levels,
}: {
  book: TerminalBook | null;
  error: string | null;
  decimals: number;
  base: string;
  quote: string;
  last: number | null;
  levels: number;
}) {
  if (!book)
    return (
      <div className={`empty small ${error ? 'warn' : ''}`}>
        {error ? `Order book unavailable: ${error}` : 'Loading…'}
      </div>
    );
  const asks = withTotals(book.asks.slice(0, levels));
  const bids = withTotals(book.bids.slice(0, levels));
  const max = Math.max(asks.at(-1)?.total ?? 0, bids.at(-1)?.total ?? 0) || 1;
  const row = (side: 'ask' | 'bid') => (l: { price: number; size: number; total: number }) => (
    <tr key={`${side}${l.price}`} className={`book-row book-${side}`}>
      <td className={`num ${side === 'ask' ? 'neg' : 'pos'}`}>{formatFixed(l.price, decimals)}</td>
      <td className="num">{formatSize(l.size)}</td>
      <td className="num">
        {formatSize(l.total)}
        <span className="book-bar" style={{ width: `${(l.total / max) * 100}%` }} aria-hidden />
      </td>
    </tr>
  );
  return (
    <div className="book">
      <table className="book-table">
        <thead>
          <tr>
            <th className="num">Price ({quote})</th>
            <th className="num">Size ({base})</th>
            <th className="num">Total ({base})</th>
          </tr>
        </thead>
        <tbody>{[...asks].reverse().map(row('ask'))}</tbody>
        <tbody>
          <tr className="book-mid">
            <td colSpan={3}>
              <span className="book-last">{last === null ? '—' : formatFixed(last, decimals)}</span>
              <span className="muted small">
                spread {book.spreadPct === null ? '—' : formatSmallPct(book.spreadPct)}
              </span>
            </td>
          </tr>
        </tbody>
        <tbody>{bids.map(row('bid'))}</tbody>
      </table>
      <p className="small muted book-note">
        Exchange order book (REST) at {formatClock(book.ts)}
        {error ? <span className="warn"> · refresh failed: {error}</span> : null}
      </p>
    </div>
  );
}

/** The newest trades from the collector's stream (only those above its size filter). */
export function TradesTape({
  trades,
  decimals,
  base,
  minNotional,
  since,
}: {
  trades: TerminalTrade[];
  decimals: number;
  base: string;
  minNotional: number;
  since: number | null;
}) {
  return (
    <div className="tape">
      <p className="small muted tape-note">
        Trades of at least ${formatCompact(minNotional)} (the collector&apos;s filter; Hyperliquid TWAP slices
        are always kept), from the live stream.
      </p>
      {trades.length === 0 ? (
        <div className="empty small">No such trades{since ? ` since ${formatClock(since)}` : ''}.</div>
      ) : (
        <table className="book-table">
          <thead>
            <tr>
              <th className="num">Price</th>
              <th className="num">Size ({base})</th>
              <th className="num">Time</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={`${t.ts}:${i}`}>
                <td className={`num ${t.side === 'buy' ? 'pos' : 'neg'}`}>
                  {formatFixed(t.price, decimals)}
                  {t.twapSlice && (
                    <span
                      className="badge badge-info tape-twap"
                      title="Hyperliquid TWAP slice (zero transaction hash)"
                    >
                      TWAP
                    </span>
                  )}
                </td>
                <td className="num">{formatSize(t.size)}</td>
                <td className="num muted">{formatClock(t.ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
