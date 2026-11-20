import { useCallback, useMemo, useState } from 'react';
import {
  EXCHANGE_NAMES,
  type ExchangeId,
  type Field,
  type MarketField,
  type MarketsResponse,
  type MarketTableRow,
  type UniverseInfo,
} from '@mip/core/types';
import { api } from '../api';
import { formatClock, formatCompact, formatCountdown, formatPrice, formatRate, formatWhen } from '../format';
import { useNow, usePersistentState, usePolling, useTopic } from '../hooks';
import { routeHash } from '../route';

interface Column {
  field: MarketField;
  label: string;
  format: (v: number, now: number) => string;
}

const COLUMNS: Column[] = [
  { field: 'last', label: 'Last', format: formatPrice },
  { field: 'mark', label: 'Mark', format: formatPrice },
  { field: 'index', label: 'Index', format: formatPrice },
  { field: 'bid', label: 'Bid', format: formatPrice },
  { field: 'ask', label: 'Ask', format: formatPrice },
  { field: 'fundingRate', label: 'Funding', format: formatRate },
  { field: 'fundingIntervalHours', label: 'Int.', format: (v) => `${v}h` },
  { field: 'nextFundingTime', label: 'Next fund.', format: formatCountdown },
  { field: 'openInterest', label: 'OI (base)', format: formatCompact },
  { field: 'turnover24h', label: '24h turnover', format: formatCompact },
];

const REASON_LABEL: Record<string, string> = {
  not_provided: 'not provided by the exchange',
  requires_api_key: 'needs an API key',
  not_received: 'no data received yet',
  stale: 'stale',
  invalid: 'rejected by validation',
  warming_up: 'warming up',
  disabled: 'disabled',
  not_implemented: 'not implemented',
  error: 'error',
};

function Cell({ field, column, now }: { field: Field<number>; column: Column; now: number }) {
  if (field.available) return <td className="num">{column.format(field.value, now)}</td>;
  const title = `${REASON_LABEL[field.reason] ?? field.reason}${field.detail ? `: ${field.detail}` : ''}`;
  const cls = field.reason === 'stale' || field.reason === 'invalid' ? 'warn' : 'muted';
  return (
    <td className={`num ${cls}`} title={title}>
      {field.reason === 'stale' ? 'stale' : field.reason === 'invalid' ? 'invalid' : '—'}
    </td>
  );
}

function UniverseSummary({ universe }: { universe: UniverseInfo | null }) {
  if (!universe) return <span className="muted small">Universe not built yet</span>;
  const source = universe.source === 'coingecko' ? 'CoinGecko market cap' : '24 h perp turnover';
  const notes = universe.warnings.length + universe.problems.length;
  return (
    <details className="universe small">
      <summary>
        {universe.assets.length} assets · ranked by {source} · built {formatWhen(universe.builtAt)}
        {notes > 0 ? (
          <span className="warn">
            {' '}
            · {notes} note{notes > 1 ? 's' : ''}
          </span>
        ) : null}
      </summary>
      {notes === 0 ? (
        <p className="muted">Every selected instrument passed the price check against the reference price.</p>
      ) : (
        <ul>
          {universe.warnings.map((w) => (
            <li key={w} className="warn">
              {w}
            </li>
          ))}
          {universe.problems.map((p) => (
            <li key={`${p.exchange}:${p.symbol}:${p.assetId}`}>
              {EXCHANGE_NAMES[p.exchange]} {p.symbol} ≠ {p.assetId}: <span className="muted">{p.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

type SortKey = MarketField | 'rank' | 'symbol';

const sortValue = (r: MarketTableRow, key: SortKey): number | string | null => {
  if (key === 'rank') return r.assetRank;
  if (key === 'symbol') return r.symbol;
  const f = r.fields[key];
  return f.available ? f.value : null;
};

export function MarketPanel({
  exchanges,
  onUnauthorized,
  onAsset,
}: {
  exchanges: ExchangeId[];
  onUnauthorized: () => void;
  onAsset: (asset: string) => void;
}) {
  const [picked, setPicked] = useState<ExchangeId | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = usePersistentState<{ key: SortKey; dir: 'asc' | 'desc' }>('mip.marketSort.v1', {
    key: 'rank',
    dir: 'asc',
  });
  const exchange = picked && exchanges.includes(picked) ? picked : (exchanges[0] ?? null);
  const now = useNow();

  const fetchMarkets = useCallback(
    () => (exchange ? api.markets(exchange) : Promise.resolve(null)),
    [exchange],
  );
  const markets = useTopic<MarketsResponse | null>(
    exchange ? `markets:${exchange}` : null,
    fetchMarkets,
    2_000,
    onUnauthorized,
  );
  const universe = usePolling(api.universe, 30_000, onUnauthorized);

  const rows = useMemo(() => {
    const all: MarketTableRow[] = markets.data?.exchange === exchange ? markets.data.rows : [];
    const q = query.trim().toUpperCase();
    const filtered = q
      ? all.filter((r) => r.symbol.includes(q) || (r.instrument?.asset ?? '').includes(q))
      : all;
    return [...filtered].sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      // Unavailable values sort last in both directions.
      if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
      const c =
        typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? c : -c;
    });
  }, [markets.data, exchange, query, sort]);

  const header = (key: SortKey, label: string, numeric: boolean, title?: string) => {
    const active = sort.key === key;
    return (
      <th
        key={key}
        className={numeric ? 'num' : undefined}
        title={title}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <button
          type="button"
          className={`sort ${active ? 'sort-active' : ''}`}
          onClick={() =>
            setSort(
              active
                ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
                : { key, dir: numeric && key !== 'rank' ? 'desc' : 'asc' },
            )
          }
        >
          {label}
          <span aria-hidden className="sort-arrow">
            {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  return (
    <section className="panel" aria-labelledby="markets-title">
      <header className="panel-head">
        <h2 id="markets-title">Market data</h2>
        <UniverseSummary universe={universe.data?.universe ?? null} />
      </header>
      {exchanges.length === 0 ? (
        <div className="empty">No exchange is streaming yet.</div>
      ) : (
        <>
          <div className="toolbar">
            <div className="tabs" role="tablist" aria-label="Exchange">
              {exchanges.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  role="tab"
                  aria-selected={ex === exchange}
                  className={`tab ${ex === exchange ? 'tab-active' : ''}`}
                  onClick={() => setPicked(ex)}
                >
                  {EXCHANGE_NAMES[ex]}
                </button>
              ))}
            </div>
            <input
              className="search"
              type="search"
              placeholder="Filter: BTC, PEPE…"
              aria-label="Filter instruments"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="muted small">
              {markets.data?.stale ? (
                <span className="warn">collector stopped publishing</span>
              ) : (
                `${rows.length} instruments · ${formatClock(markets.data?.ts ?? null)}`
              )}
            </span>
          </div>
          <div className="table-wrap market-table">
            <table className="table">
              <thead>
                <tr>
                  {header('rank', '#', true)}
                  {header('symbol', 'Symbol', false)}
                  {COLUMNS.map((c) =>
                    header(c.field, c.label, true, markets.data?.capabilities?.[c.field]?.note),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol}>
                    <td className="num muted">{r.assetRank ?? ''}</td>
                    <td>
                      {r.instrument && (
                        <button
                          type="button"
                          className="link asset-btn"
                          onClick={() => onAsset(r.instrument!.asset)}
                          title={`Coin details for ${r.instrument.asset} across exchanges`}
                        >
                          ⓘ
                        </button>
                      )}
                      <a
                        className="asset-btn"
                        href={routeHash({ page: 'terminal', exchange: exchange!, symbol: r.symbol })}
                        title={`Open ${r.symbol} in the terminal`}
                        aria-label={`Chart of ${r.symbol}`}
                      >
                        <ChartIcon />
                      </a>
                      {r.instrument ? (
                        <a
                          href={r.instrument.url}
                          target="_blank"
                          rel="noreferrer"
                          title={`${r.instrument.asset} ×${r.instrument.multiplier}, quote ${r.instrument.quote}`}
                        >
                          {r.symbol}
                        </a>
                      ) : (
                        r.symbol
                      )}
                    </td>
                    {COLUMNS.map((c) => (
                      <Cell key={c.field} field={r.fields[c.field]} column={c} now={now} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div className="empty">{markets.error ?? 'No instruments match.'}</div>}
          </div>
          <footer className="legend small muted">
            Prices in quote currency per contract base unit (hover a symbol for its multiplier). Open interest
            is one side, in base units. “—” = not available, “stale” = no fresh data; hover a cell for the
            reason.
          </footer>
        </>
      )}
    </section>
  );
}

/** Small candlestick glyph for "open in terminal" links. */
function ChartIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden fill="currentColor">
      <rect x="1.5" y="3" width="2" height="5" />
      <rect x="2.25" y="1" width="0.5" height="9" />
      <rect x="7" y="5" width="2" height="4" />
      <rect x="7.75" y="3" width="0.5" height="8" />
    </svg>
  );
}
