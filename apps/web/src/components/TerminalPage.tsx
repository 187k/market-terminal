import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EXCHANGE_IDS,
  EXCHANGE_NAMES,
  type AssetDetailResponse,
  type CandleInterval,
  type ExchangeId,
  type Field,
  type TerminalLiveResponse,
  type UniverseAsset,
} from '@mip/core/types';
import { api } from '../api';
import {
  formatClock,
  formatCompact,
  formatCountdown,
  formatFixed,
  formatRate,
  formatSignedPct,
  priceDecimals,
} from '../format';
import { useNow, usePersistentState, usePolling, useTopic } from '../hooks';
import { navigate, type Route } from '../route';
import { CandleChart, type PriceLineSpec } from './CandleChart';
import { OrderBook, TradesTape } from './OrderBook';

type TerminalRoute = Extract<Route, { page: 'terminal' }>;

interface Saved {
  exchange: ExchangeId | null;
  symbol: string | null;
  interval: CandleInterval;
}

const SAVED_DEFAULT: Saved = { exchange: null, symbol: null, interval: '5m' };

/** A value from the live stream, or why there is none (stale values are marked, never shown as current). */
function FieldText({ f, format }: { f: Field<number> | undefined; format: (v: number) => string }) {
  if (!f) return <span className="muted">—</span>;
  if (f.available) return <>{format(f.value)}</>;
  const title = `${f.reason}${f.detail ? `: ${f.detail}` : ''}`;
  if (f.reason === 'stale' || f.reason === 'invalid')
    return (
      <span className="warn" title={title}>
        {f.reason}
      </span>
    );
  return (
    <span className="muted" title={title}>
      —
    </span>
  );
}

function Stat({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="term-stat" title={title}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Searchable list of the monitored assets. */
function AssetPicker({
  assets,
  current,
  onPick,
}: {
  assets: UniverseAsset[];
  current: ReactNode;
  onPick: (a: UniverseAsset) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const q = query.trim().toUpperCase();
  const list = q ? assets.filter((a) => a.symbol.includes(q) || a.name.toUpperCase().includes(q)) : assets;
  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current} <span className="muted">▾</span>
      </button>
      {open && (
        <div className="picker-pop">
          <input
            autoFocus
            className="search"
            type="search"
            placeholder="Search: BTC, Solana…"
            aria-label="Search assets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && list[0]) {
                onPick(list[0]);
                setOpen(false);
              }
            }}
          />
          <ul role="listbox" aria-label="Assets">
            {list.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onPick(a);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <span className="muted picker-rank">{a.rank}</span>
                  <b>{a.symbol}</b> <span className="muted">{a.name}</span>
                  <span className="muted picker-count">{a.instruments.length} ex.</span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="empty small">No monitored asset matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * View-only trading terminal for one instrument: chart, order book and trades, with the
 * instrument's live values. It displays public market data only and never places orders.
 */
export function TerminalPage({
  route,
  onUnauthorized,
  onAsset,
}: {
  route: TerminalRoute;
  onUnauthorized: () => void;
  onAsset: (asset: string) => void;
}) {
  const now = useNow();
  const [saved, setSaved] = usePersistentState<Saved>('mip.terminal.v1', SAVED_DEFAULT);
  const [side, setSide] = useState<'book' | 'trades'>('book');
  const universe = usePolling(api.universe, 60_000, onUnauthorized);
  const assets = universe.data?.universe?.assets ?? [];

  // Fill in what the URL leaves out: the last viewed instrument, else the largest asset.
  const resolved = ((): { exchange: ExchangeId; symbol: string } | null => {
    if (route.exchange && route.symbol) return { exchange: route.exchange, symbol: route.symbol };
    if (route.exchange) {
      const first = assets.flatMap((a) => a.instruments).find((i) => i.exchange === route.exchange);
      return first ? { exchange: first.exchange, symbol: first.symbol } : null;
    }
    if (saved.exchange && saved.symbol) return { exchange: saved.exchange, symbol: saved.symbol };
    return assets[0]?.instruments[0] ?? null;
  })();
  const exchange = resolved?.exchange ?? null;
  const symbol = resolved?.symbol ?? null;
  const interval = route.interval ?? saved.interval;
  useEffect(() => {
    if (!exchange || !symbol) return;
    if (route.exchange !== exchange || route.symbol !== symbol || route.interval !== interval)
      navigate({ page: 'terminal', exchange, symbol, interval }, true);
    if (saved.exchange !== exchange || saved.symbol !== symbol || saved.interval !== interval)
      setSaved({ exchange, symbol, interval });
  });

  const go = (ex: ExchangeId, sym: string, iv: CandleInterval = interval) =>
    navigate({ page: 'terminal', exchange: ex, symbol: sym, interval: iv });

  const topic = exchange && symbol ? (`terminal:${exchange}:${symbol}:${interval}` as const) : null;
  const fetchLive = useCallback(
    () => (exchange && symbol ? api.terminal(exchange, symbol, interval) : Promise.resolve(null)),
    [exchange, symbol, interval],
  );
  const res = useTopic<TerminalLiveResponse | null>(topic, fetchLive, 2_000, onUnauthorized);
  const d =
    res.data && res.data.exchange === exchange && res.data.symbol === symbol && res.data.interval === interval
      ? res.data
      : null;

  const inst = d?.instrument ?? null;
  const assetEntry = useMemo(
    () =>
      assets.find((a) => a.instruments.some((i) => i.exchange === exchange && i.symbol === symbol)) ??
      (inst ? assets.find((a) => a.symbol === inst.asset) : undefined),
    [assets, exchange, symbol, inst],
  );
  const assetCode = inst?.asset ?? assetEntry?.symbol ?? null;
  const fetchAsset = useCallback(
    () => (assetCode ? api.asset(assetCode) : Promise.resolve(null)),
    [assetCode],
  );
  const assetRes = useTopic<AssetDetailResponse | null>(
    assetCode ? `asset:${assetCode}` : null,
    fetchAsset,
    3_000,
    onUnauthorized,
  );
  const assetRows = assetRes.data?.asset === assetCode ? assetRes.data.rows : [];

  const fields = d?.fields ?? null;
  const last = fields?.last.available ? fields.last.value : null;
  const reference = last ?? (fields?.mark.available ? fields.mark.value : null);
  const decimals = priceDecimals(inst?.tickSize ?? null, reference);
  const minMove = inst?.tickSize && inst.tickSize > 0 ? inst.tickSize : 10 ** -decimals;
  const prevLast = useRef<{ key: string; value: number | null; dir: 'up' | 'down' | null }>({
    key: '',
    value: null,
    dir: null,
  });
  const key = `${exchange}:${symbol}`;
  if (prevLast.current.key !== key) prevLast.current = { key, value: last, dir: null };
  else if (last !== null && prevLast.current.value !== null && last !== prevLast.current.value)
    prevLast.current = { key, value: last, dir: last > prevLast.current.value ? 'up' : 'down' };
  else if (last !== null) prevLast.current.value = last;
  const dir = prevLast.current.dir;

  const p = (v: number) => formatFixed(v, decimals);
  const base = inst?.base ?? '';
  const quote = inst?.quote ?? '';
  const indexLabel = inst?.indexKind === 'oracle' ? 'Oracle' : 'Index';
  const lines: PriceLineSpec[] = useMemo(
    () => [
      { key: 'mark', label: 'Mark', price: fields?.mark.available ? fields.mark.value : null },
      { key: 'index', label: indexLabel, price: fields?.index.available ? fields.index.value : null },
    ],
    [fields, indexLabel],
  );
  const stats = d?.stats24h ?? null;

  const pickAsset = (a: UniverseAsset) => {
    const same = a.instruments.find((i) => i.exchange === exchange) ?? a.instruments[0];
    if (same) go(same.exchange, same.symbol);
  };

  const exchangesOfAsset = (assetEntry?.instruments ?? [])
    .slice()
    .sort((a, b) => EXCHANGE_IDS.indexOf(a.exchange) - EXCHANGE_IDS.indexOf(b.exchange));

  if (!exchange || !symbol)
    return (
      <main className="terminal-empty">
        <div className="empty">{universe.error ?? 'Loading the monitored instruments…'}</div>
      </main>
    );

  return (
    <main className="terminal">
      <section className="panel term-head" aria-label="Instrument">
        <div className="term-title">
          <AssetPicker
            assets={assets}
            onPick={pickAsset}
            current={
              <>
                <b className="term-symbol">{inst ? `${inst.base}/${inst.quote}` : symbol}</b>
                <span className="muted small"> Perpetual · {EXCHANGE_NAMES[exchange]}</span>
              </>
            }
          />
          <div className="term-price">
            <span className={`term-last ${dir === 'up' ? 'pos' : dir === 'down' ? 'neg' : ''}`}>
              <FieldText f={fields?.last} format={p} />
            </span>
            {stats?.changePct !== null && stats?.changePct !== undefined && (
              <span className={stats.changePct > 0 ? 'pos' : stats.changePct < 0 ? 'neg' : 'muted'}>
                {formatSignedPct(stats.changePct)}
              </span>
            )}
          </div>
          <div className="term-links small">
            {assetCode && (
              <button type="button" className="link" onClick={() => onAsset(assetCode)}>
                Coin view
              </button>
            )}
            {inst && (
              <a href={inst.url} target="_blank" rel="noreferrer">
                {EXCHANGE_NAMES[exchange]} page ↗
              </a>
            )}
          </div>
        </div>
        <dl className="term-stats">
          <Stat
            label="24h high"
            title={stats ? `Highest price of the last ${stats.hours} hourly candles` : undefined}
          >
            {stats ? p(stats.high) : <span className="muted">—</span>}
          </Stat>
          <Stat
            label="24h low"
            title={stats ? `Lowest price of the last ${stats.hours} hourly candles` : undefined}
          >
            {stats ? p(stats.low) : <span className="muted">—</span>}
          </Stat>
          <Stat
            label={`24h volume${base ? ` (${base})` : ''}`}
            title="Sum of the last hourly candles' volume"
          >
            {stats ? formatCompact(stats.volume) : <span className="muted">—</span>}
          </Stat>
          <Stat label={`24h turnover${quote ? ` (${quote})` : ''}`} title="The exchange's 24 h traded value">
            <FieldText f={fields?.turnover24h} format={formatCompact} />
          </Stat>
          <Stat label="Mark">
            <FieldText f={fields?.mark} format={p} />
          </Stat>
          <Stat
            label={indexLabel}
            title={
              inst?.indexKind === 'oracle'
                ? 'Hyperliquid publishes an oracle price instead of an index'
                : undefined
            }
          >
            <FieldText f={fields?.index} format={p} />
          </Stat>
          <Stat label="Funding / countdown">
            <FieldText f={fields?.fundingRate} format={formatRate} />{' '}
            <span className="muted small">
              <FieldText f={fields?.nextFundingTime} format={(t) => formatCountdown(t, now)} />
              {fields?.fundingIntervalHours.available ? ` · ${fields.fundingIntervalHours.value}h` : ''}
            </span>
          </Stat>
          <Stat label={`Open interest${base ? ` (${base})` : ''}`} title="One side, base units">
            <FieldText f={fields?.openInterest} format={formatCompact} />
          </Stat>
        </dl>
        {exchangesOfAsset.length > 0 && (
          <div className="term-exchanges tabs" role="tablist" aria-label="Exchange">
            {exchangesOfAsset.map((i) => {
              const row = assetRows.find((r) => r.exchange === i.exchange && r.symbol === i.symbol);
              const active = i.exchange === exchange && i.symbol === symbol;
              return (
                <button
                  key={`${i.exchange}:${i.symbol}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`tab ${active ? 'tab-active' : ''}`}
                  onClick={() => go(i.exchange, i.symbol)}
                  title={i.symbol}
                >
                  {EXCHANGE_NAMES[i.exchange]}{' '}
                  <span className="muted">
                    <FieldText
                      f={row?.fields.last}
                      format={(v) => formatFixed(v, priceDecimals(row?.instrument?.tickSize ?? null, v))}
                    />
                    {row?.instrument && row.instrument.multiplier !== 1
                      ? ` ×${row.instrument.multiplier}`
                      : ''}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {inst && inst.multiplier !== 1 && (
          <p className="small muted term-note">
            Prices are per {inst.base} (= {inst.multiplier} {inst.asset}); sizes are in {inst.base}.
          </p>
        )}
        {d?.stale && (
          <p className="small warn term-note">The collector stopped publishing: live values are stale.</p>
        )}
        {d && !inst && <p className="small warn term-note">{d.candlesError}</p>}
        {res.error && !d && <p className="small neg term-note">{res.error}</p>}
      </section>

      <section className="panel term-chart" aria-label="Chart">
        <CandleChart
          exchange={exchange}
          symbol={symbol}
          interval={interval}
          decimals={decimals}
          minMove={minMove}
          live={d?.candles ?? EMPTY}
          lines={lines}
          volumeUnit={base}
          onInterval={(iv) => go(exchange, symbol, iv)}
          onUnauthorized={onUnauthorized}
        />
        <div className="term-sources small muted">
          <span>
            Candles: {EXCHANGE_NAMES[exchange]} public API
            {d?.candlesSyncedAt ? `, synced ${formatClock(d.candlesSyncedAt)}` : ''}. The forming
            candle&apos;s price follows the live stream; its volume updates with each sync.
          </span>
          {d?.candlesError && inst && <span className="warn">Sync failed: {d.candlesError}</span>}
          {d?.statsError && inst && <span className="warn">24 h figures unavailable: {d.statsError}</span>}
          {d?.notes.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      </section>

      <section className="panel term-side" aria-label="Order book and trades">
        <div className="panel-head">
          <div className="tabs" role="tablist" aria-label="Side panel">
            <button
              type="button"
              role="tab"
              aria-selected={side === 'book'}
              className={`tab ${side === 'book' ? 'tab-active' : ''}`}
              onClick={() => setSide('book')}
            >
              Order book
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={side === 'trades'}
              className={`tab ${side === 'trades' ? 'tab-active' : ''}`}
              onClick={() => setSide('trades')}
            >
              Trades
            </button>
          </div>
        </div>
        {side === 'book' ? (
          <OrderBook
            book={d?.book ?? null}
            error={d ? d.bookError : res.error}
            decimals={decimals}
            base={base}
            quote={quote}
            last={last}
            levels={12}
          />
        ) : (
          <TradesTape
            trades={d?.trades ?? []}
            decimals={decimals}
            base={base}
            minNotional={d?.tradesMinNotional ?? 0}
            since={d?.tradesSince ?? null}
          />
        )}
      </section>

      <p className="small muted disclaimer term-disclaimer">
        View only: this dashboard never places, changes or cancels orders. Market data for analysis, not a
        trading recommendation.
      </p>
    </main>
  );
}

const EMPTY: never[] = [];
