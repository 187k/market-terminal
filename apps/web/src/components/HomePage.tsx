import { useMemo, type ReactNode } from 'react';
import {
  EXCHANGE_NAMES,
  SCANNERS,
  type ConnectorHealth,
  type MarketOverviewResponse,
  type OverviewCoin,
  type PerpOverviewResponse,
  type PerpSummary,
  type ScannerId,
  type ScannersResponse,
  type SignalDto,
} from '@mip/core/types';
import { api } from '../api';
import { formatAge, formatSignedPct, formatUsd, formatUsdCompact } from '../format';
import { useNow, usePersistentState, useTopic } from '../hooks';
import { routeHash } from '../route';
import { directionTone, exName, headline, signTone, type Column } from '../signalView';
import { Badge, StateBadge } from './Badge';
import { AreaSpark, ChangePill, CoinCard } from './CoinCard';
import { changeOf, Heatmap, type ChangePeriod } from './Heatmap';
import { latestUpdates, scannerState } from './ScannerWindow';
import { SortableTable } from './SortableTable';

/** Large cards at the top of the page: the largest coins of the universe (user choice: 20). */
const CARD_COUNT = 20;
const MOVERS = 5;
const PERIODS: ChangePeriod[] = ['1h', '24h', '7d'];

type Row = OverviewCoin & { perps: PerpSummary | null };

const dash = '—';
const fundingText = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(3)} %`;
const shortName = (name: string) => name.replace(/ Scanner$/, '');

function Stat({
  label,
  value,
  extra,
  title,
}: {
  label: string;
  value: string;
  extra?: ReactNode;
  title?: string;
}) {
  return (
    <div className="stat" title={title}>
      <dt>{label}</dt>
      <dd>
        <span className="stat-value">{value}</span>
        {extra}
      </dd>
    </div>
  );
}

function GlobalBar({
  overview,
  perps,
  now,
}: {
  overview: MarketOverviewResponse | null;
  perps: PerpOverviewResponse | null;
  now: number;
}) {
  const g = overview?.global ?? null;
  const t = perps?.totals;
  const age = overview?.globalFetchedAt ? formatAge(overview.globalFetchedAt, now) : null;
  const live = perps ? new Set(perps.assets.flatMap((a) => a.venues)).size : null;
  return (
    <section className="panel global-bar" aria-label="Whole market">
      <dl className="stats">
        <Stat
          label="Market cap"
          value={g?.totalMarketCapUsd != null ? formatUsdCompact(g.totalMarketCapUsd) : dash}
          extra={
            g?.marketCapChange24hPct != null ? (
              <ChangePill value={g.marketCapChange24hPct} title="Change of the total market cap over 24 h" />
            ) : undefined
          }
          title="Total market cap of all crypto assets CoinGecko tracks"
        />
        <Stat
          label="24 h volume"
          value={g?.totalVolume24hUsd != null ? formatUsdCompact(g.totalVolume24hUsd) : dash}
          title="Spot trading volume over 24 h, all exchanges CoinGecko tracks"
        />
        <Stat
          label="BTC dominance"
          value={g?.btcDominancePct != null ? `${g.btcDominancePct.toFixed(1)} %` : dash}
          title="Bitcoin's share of the total market cap"
        />
        <Stat
          label="ETH dominance"
          value={g?.ethDominancePct != null ? `${g.ethDominancePct.toFixed(1)} %` : dash}
          title="Ether's share of the total market cap"
        />
        {g?.fearGreed && (
          <Stat
            label="Fear & Greed"
            value={String(g.fearGreed.value)}
            extra={<span className={`fg fg-${fearTone(g.fearGreed.value)}`}>{g.fearGreed.label}</span>}
            title="CoinGecko's Fear & Greed reading, 0 = extreme fear, 100 = extreme greed. Sent by CoinGecko /global but not in its documented schema, so it may disappear."
          />
        )}
        <Stat
          label="Perp open interest"
          value={t?.openInterestUsd != null ? formatUsdCompact(t.openInterestUsd) : dash}
          title="Open interest (one side) of the monitored coins' perpetuals, summed over the monitored exchanges. Bitget and BingX units are inferred, not documented."
        />
        <Stat
          label="Perp turnover 24 h"
          value={t?.turnover24hUsd != null ? formatUsdCompact(t.turnover24hUsd) : dash}
          title="24 h traded value of the monitored perpetuals, summed over the monitored exchanges"
        />
        <Stat
          label="Median funding 24 h"
          value={t?.funding24hPct != null ? fundingText(t.funding24hPct) : dash}
          title="Median over the monitored coins of their median funding rate, normalised to 24 h"
        />
      </dl>
      <p className="muted small global-src">
        Market figures: CoinGecko{age ? `, ${age}` : ''}
        {overview?.globalStale && <span className="warn"> (out of date)</span>}. Perpetuals: live from{' '}
        {live === null ? 'the monitored exchanges' : `${live} exchange${live === 1 ? '' : 's'}`}, quoted in
        USDT (USDC on Hyperliquid).
      </p>
    </section>
  );
}

const fearTone = (v: number) => (v < 25 ? 'neg' : v < 45 ? 'warn' : v <= 55 ? 'flat' : 'pos');

function MoversPanel({
  coins,
  period,
  onPeriod,
  onAsset,
}: {
  coins: OverviewCoin[];
  period: ChangePeriod;
  onPeriod: (p: ChangePeriod) => void;
  onAsset: (asset: string) => void;
}) {
  const ranked = coins
    .map((c) => ({ c, change: changeOf(c, period) }))
    .filter((x): x is { c: OverviewCoin; change: number } => x.change !== null)
    .sort((a, b) => b.change - a.change);
  const gainers = ranked.slice(0, MOVERS).filter((x) => x.change > 0);
  const losers = ranked
    .slice(-MOVERS)
    .reverse()
    .filter((x) => x.change < 0);
  const list = (title: string, rows: typeof ranked) => (
    <div className="movers-col">
      <h3 className="section-title">{title}</h3>
      {rows.length === 0 ? (
        <div className="empty small">None.</div>
      ) : (
        <ul className="movers">
          {rows.map(({ c, change }) => (
            <li key={c.asset}>
              <button
                type="button"
                className="mover"
                onClick={() => onAsset(c.asset)}
                title={`Open ${c.name}`}
              >
                <span className="mover-name">
                  <b>{c.asset}</b> <span className="muted small">{c.name}</span>
                </span>
                <AreaSpark
                  values={c.spot?.sparkline7d ?? []}
                  label={`${c.name} 7 days`}
                  fill={false}
                  className="mini-spark"
                />
                <span className="mover-price">
                  {c.spot?.priceUsd != null ? formatUsd(c.spot.priceUsd) : dash}
                </span>
                <span className={`mover-chg ${signTone(change)}`}>{formatSignedPct(change)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <section className="panel" aria-labelledby="movers-title">
      <header className="panel-head">
        <h2 id="movers-title">Top movers</h2>
        <PeriodTabs period={period} onPeriod={onPeriod} />
      </header>
      <div className="movers-grid">
        {list('Gainers', gainers)}
        {list('Losers', losers)}
      </div>
      <p className="muted small pad-x">
        Among the {coins.length} monitored coins; price change from CoinGecko.
      </p>
    </section>
  );
}

function PeriodTabs({ period, onPeriod }: { period: ChangePeriod; onPeriod: (p: ChangePeriod) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Change period">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={p === period}
          className={`tab ${p === period ? 'tab-active' : ''}`}
          onClick={() => onPeriod(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function SignalsHealthPanel({
  scanners,
  active,
  recent,
  engineAlive,
  exchanges,
  now,
  onScanner,
}: {
  scanners: ScannersResponse | null;
  active: SignalDto[];
  recent: SignalDto[];
  engineAlive: boolean | null;
  exchanges: ConnectorHealth[];
  now: number;
  onScanner: (id: ScannerId) => void;
}) {
  const updates = latestUpdates(active, recent, 7);
  const activeBy = (id: ScannerId) => active.filter((s) => s.scanner === id).length;
  return (
    <section className="panel" aria-labelledby="sig-title">
      <header className="panel-head">
        <h2 id="sig-title">Signals and exchanges</h2>
        <a className="small" href={routeHash({ page: 'dashboard' })}>
          Scanner dashboard →
        </a>
      </header>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Scanner</th>
              <th>State</th>
              <th className="num">Active</th>
              <th className="num">24 h</th>
            </tr>
          </thead>
          <tbody>
            {SCANNERS.map((sc) => {
              const status = scanners?.scanners.find((x) => x.id === sc.id);
              const state = scannerState(status, engineAlive, now);
              return (
                <tr
                  key={sc.id}
                  className="clickable"
                  onClick={() => onScanner(sc.id)}
                  title={`Open the ${sc.name}`}
                >
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        onScanner(sc.id);
                      }}
                    >
                      {shortName(sc.name)}
                    </button>
                  </td>
                  <td>
                    <Badge tone={state.tone} {...(state.title ? { title: state.title } : {})}>
                      {state.label}
                    </Badge>
                  </td>
                  <td className="num">{status ? activeBy(sc.id) : dash}</td>
                  <td className="num">{status ? status.signals24h : dash}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 className="section-title">Latest signal updates</h3>
      {updates.length === 0 ? (
        <div className="empty small">Nothing yet.</div>
      ) : (
        <ul className="updates small" aria-label="Latest signal updates">
          {updates.map((u) => (
            <li key={`${u.kind}:${u.signal.id || u.signal.key}:${u.ts}`} title={u.signal.title}>
              <span className={`update-kind update-${u.kind}`}>{u.kind}</span>
              <span className="update-text">
                {u.signal.asset} <b className={directionTone(u.signal.direction)}>{headline(u.signal)}</b>{' '}
                <span className="muted">
                  {shortName(SCANNERS.find((x) => x.id === u.signal.scanner)?.name ?? '')}
                </span>
              </span>
              <span className="muted">{formatAge(u.ts, now)}</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="section-title">Exchanges</h3>
      {exchanges.length === 0 ? (
        <div className="empty small">No connection report from the collector yet.</div>
      ) : (
        <ul className="ex-strip">
          {exchanges.map((ex) => (
            <li key={ex.exchange} className="ex-chip">
              <span>{EXCHANGE_NAMES[ex.exchange]}</span>
              <StateBadge state={ex.state} {...(ex.detail ? { title: ex.detail } : {})} />
              {ex.data && ex.data.tracked > 0 && (
                <span
                  className={`small ${ex.data.fresh < ex.data.tracked ? 'warn' : 'muted'}`}
                  title="Instruments with fresh mark, bid and ask / instruments streamed"
                >
                  {ex.data.fresh}/{ex.data.tracked}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function tableColumns(onAsset: (a: string) => void): Column<Row>[] {
  const pct = (v: number | null | undefined, digits = 2) =>
    v == null ? dash : <span className={signTone(v)}>{formatSignedPct(v, digits)}</span>;
  return [
    { key: 'rank', label: '#', numeric: true, sortValue: (r) => r.rank, render: (r) => r.rank },
    {
      key: 'coin',
      label: 'Coin',
      sortValue: (r) => r.asset,
      render: (r) => (
        <button type="button" className="link" onClick={() => onAsset(r.asset)} title={`Open ${r.name}`}>
          <b>{r.asset}</b> <span className="muted">{r.name}</span>
        </button>
      ),
    },
    {
      key: 'price',
      label: 'Price',
      numeric: true,
      sortValue: (r) => r.spot?.priceUsd ?? null,
      render: (r) => (r.spot?.priceUsd != null ? formatUsd(r.spot.priceUsd) : dash),
    },
    {
      key: 'c1h',
      label: '1h',
      numeric: true,
      sortValue: (r) => r.spot?.change1hPct ?? null,
      render: (r) => pct(r.spot?.change1hPct),
    },
    {
      key: 'c24h',
      label: '24h',
      numeric: true,
      sortValue: (r) => r.spot?.change24hPct ?? null,
      render: (r) => pct(r.spot?.change24hPct),
    },
    {
      key: 'c7d',
      label: '7d',
      numeric: true,
      sortValue: (r) => r.spot?.change7dPct ?? null,
      render: (r) => pct(r.spot?.change7dPct),
    },
    {
      key: 'spark',
      label: '7 days',
      render: (r) => (
        <AreaSpark
          values={r.spot?.sparkline7d ?? []}
          label={`${r.name} 7 days`}
          fill={false}
          className="mini-spark"
        />
      ),
    },
    {
      key: 'mcap',
      label: 'Market cap',
      numeric: true,
      sortValue: (r) => r.spot?.marketCapUsd ?? null,
      render: (r) => (r.spot?.marketCapUsd != null ? formatUsdCompact(r.spot.marketCapUsd) : dash),
    },
    {
      key: 'vol',
      label: 'Volume 24h',
      title: 'Spot volume over 24 h (CoinGecko)',
      numeric: true,
      sortValue: (r) => r.spot?.volume24hUsd ?? null,
      render: (r) => (r.spot?.volume24hUsd != null ? formatUsdCompact(r.spot.volume24hUsd) : dash),
    },
    {
      key: 'funding',
      label: 'Funding 24h',
      title: 'Median perpetual funding rate over the monitored exchanges, normalised to 24 h',
      numeric: true,
      sortValue: (r) => r.perps?.funding24hPct ?? null,
      render: (r) => {
        const p = r.perps;
        if (p?.funding24hPct == null) return dash;
        const range =
          p.fundingLow && p.fundingHigh
            ? `Lowest ${fundingText(p.fundingLow.rate24hPct)} on ${exName(p.fundingLow.exchange)}, highest ${fundingText(p.fundingHigh.rate24hPct)} on ${exName(p.fundingHigh.exchange)}`
            : undefined;
        return (
          <span className={signTone(p.funding24hPct)} title={range}>
            {fundingText(p.funding24hPct)}
          </span>
        );
      },
    },
    {
      key: 'premium',
      label: 'Premium',
      title: 'Median over exchanges of (mark − index) / index × 100; Hyperliquid uses its oracle price',
      numeric: true,
      sortValue: (r) => r.perps?.premiumPct ?? null,
      render: (r) => pct(r.perps?.premiumPct, 3),
    },
    {
      key: 'oi',
      label: 'Open interest',
      title: 'Perpetual open interest (one side) × mark, summed over the monitored exchanges',
      numeric: true,
      sortValue: (r) => r.perps?.openInterestUsd ?? null,
      render: (r) =>
        r.perps?.openInterestUsd != null ? (
          <span title={`${r.perps.oiVenues.map(exName).join(', ')}`}>
            {formatUsdCompact(r.perps.openInterestUsd)}
          </span>
        ) : (
          dash
        ),
    },
    {
      key: 'oi24',
      label: 'OI 24h',
      title:
        'Change of open interest in coins against the snapshot nearest 24 h ago, exchanges with both values',
      numeric: true,
      sortValue: (r) => r.perps?.oiChange24hPct ?? null,
      render: (r) => pct(r.perps?.oiChange24hPct, 1),
    },
    {
      key: 'venues',
      label: 'Exch.',
      title: 'Exchanges with fresh perpetual data for this coin',
      numeric: true,
      sortValue: (r) => r.perps?.venues.length ?? null,
      render: (r) =>
        r.perps ? <span title={r.perps.venues.map(exName).join(', ')}>{r.perps.venues.length}</span> : dash,
    },
  ];
}

/**
 * Home page: whole-market figures, the largest coins as cards, top movers, signal and exchange
 * health, a market map and every monitored coin in one table. Spot figures come from CoinGecko,
 * perpetual figures from the monitored exchanges.
 */
export function HomePage({
  status,
  scanners,
  active,
  recent,
  engineAlive,
  onUnauthorized,
  onAsset,
  onScanner,
}: {
  status: { exchanges: ConnectorHealth[] } | null;
  scanners: ScannersResponse | null;
  active: SignalDto[];
  recent: SignalDto[];
  engineAlive: boolean | null;
  onUnauthorized: () => void;
  onAsset: (asset: string) => void;
  onScanner: (id: ScannerId) => void;
}) {
  const now = useNow();
  // CoinGecko figures change once per collector poll; the perpetual figures every few seconds.
  const overview = useTopic<MarketOverviewResponse>('overview', api.overview, 15_000, onUnauthorized);
  const perps = useTopic<PerpOverviewResponse>('perps', api.perps, 5_000, onUnauthorized);
  const [view, setView] = usePersistentState('mip.home.v1', { period: '24h' as ChangePeriod });
  const period = PERIODS.includes(view.period) ? view.period : '24h';
  const setPeriod = (p: ChangePeriod) => setView({ period: p });

  const o = overview.data;
  const coins = useMemo(() => o?.coins ?? [], [o]);
  const perpsBy = useMemo(() => new Map((perps.data?.assets ?? []).map((p) => [p.asset, p])), [perps.data]);
  const rows: Row[] = useMemo(
    () => coins.map((c) => ({ ...c, perps: perpsBy.get(c.asset) ?? null })),
    [coins, perpsBy],
  );
  const columns = useMemo(() => tableColumns(onAsset), [onAsset]);

  // Cards: the largest by CoinGecko market cap; coins without one keep their universe rank.
  const cards = useMemo(
    () =>
      [...rows]
        .sort(
          (a, b) =>
            (a.spot?.marketCapRank ?? Infinity) - (b.spot?.marketCapRank ?? Infinity) || a.rank - b.rank,
        )
        .slice(0, CARD_COUNT),
    [rows],
  );

  const notes = [
    ...(o?.notes ?? []),
    ...(overview.error ? [`Market overview: ${overview.error}`] : []),
    ...(perps.error ? [`Perpetual figures: ${perps.error}`] : []),
    ...(perps.data?.staleExchanges.length
      ? [
          `No current data from ${perps.data.staleExchanges.map(exName).join(', ')}: left out of the perpetual figures.`,
        ]
      : []),
    ...(perps.data && perps.data.oiBaselineAt === null && coins.length > 0
      ? ['OI 24 h change unavailable: no stored snapshots from 24 hours ago yet.']
      : []),
  ];

  return (
    <main className="home">
      <GlobalBar overview={o} perps={perps.data} now={now} />
      {notes.length > 0 && (
        <ul className="home-notes small" aria-label="Data problems">
          {notes.map((n) => (
            <li key={n}>⚠ {n}</li>
          ))}
        </ul>
      )}

      <section aria-labelledby="cards-title">
        <div className="home-head">
          <h2 id="cards-title">Largest coins</h2>
          <span className="muted small">
            Top {CARD_COUNT} of the monitored universe by market cap · price and 7-day chart from CoinGecko ·
            click a card for the coin view
          </span>
        </div>
        {!o ? (
          <div className="panel empty">Loading…</div>
        ) : cards.length === 0 ? (
          <div className="panel empty">No coins to show yet.</div>
        ) : (
          <div className="coin-grid">
            {cards.map((c) => (
              <CoinCard
                key={c.asset}
                coin={c}
                perps={c.perps}
                fetchedAt={o.coinsFetchedAt}
                stale={o.coinsStale}
                now={now}
                onOpen={onAsset}
              />
            ))}
          </div>
        )}
      </section>

      <div className="home-split">
        <MoversPanel coins={coins} period={period} onPeriod={setPeriod} onAsset={onAsset} />
        <SignalsHealthPanel
          scanners={scanners}
          active={active}
          recent={recent}
          engineAlive={engineAlive}
          exchanges={status?.exchanges ?? []}
          now={now}
          onScanner={onScanner}
        />
      </div>

      <section className="panel" aria-labelledby="heat-title">
        <header className="panel-head">
          <h2 id="heat-title">Market map</h2>
          <span className="muted small heat-legend">Size: market cap · colour: {period} price change</span>
          <PeriodTabs period={period} onPeriod={setPeriod} />
        </header>
        <div className="pad">
          <Heatmap coins={coins} period={period} onOpen={onAsset} />
        </div>
      </section>

      <section className="panel" aria-labelledby="all-title">
        <header className="panel-head">
          <h2 id="all-title">All monitored coins</h2>
          <span className="muted small">
            {coins.length} coins · spot from CoinGecko, funding / premium / open interest from the monitored
            exchanges
          </span>
        </header>
        <SortableTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.asset}
          initialSort={{ key: 'rank', dir: 'asc' }}
          onRowClick={(r) => onAsset(r.asset)}
          label="All monitored coins"
          empty={o ? 'No coins yet.' : 'Loading…'}
        />
      </section>

      <p className="disclaimer muted small">
        For analysis only; nothing here is a trading recommendation. Spot figures are CoinGecko's (USD) and
        update every few minutes; perpetual figures are live from the exchanges' public APIs. A dash means the
        value is unknown, not zero.
      </p>
    </main>
  );
}
