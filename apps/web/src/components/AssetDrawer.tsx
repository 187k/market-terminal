import { useCallback } from 'react';
import {
  EXCHANGE_NAMES,
  SCANNERS,
  type AssetDetailResponse,
  type AssetHistorySeries,
  type ExchangeId,
  type Field,
} from '@mip/core/types';
import { api } from '../api';
import { formatCompact, formatCountdown, formatPrice, formatRate, formatWhen } from '../format';
import { useNow, useTopic } from '../hooks';
import { directionTone, headline } from '../signalView';
import { Drawer } from './Drawer';
import { SignalDetails } from './SignalDetails';

const v = (f: Field<number> | undefined): number | null => (f && f.available ? f.value : null);

function Cell({ f, format }: { f: Field<number> | undefined; format: (n: number) => string }) {
  if (!f) return <td className="num muted">—</td>;
  if (f.available) return <td className="num">{format(f.value)}</td>;
  const cls = f.reason === 'stale' || f.reason === 'invalid' ? 'warn' : 'muted';
  return (
    <td className={`num ${cls}`} title={`${f.reason}${f.detail ? `: ${f.detail}` : ''}`}>
      {f.reason === 'stale' ? 'stale' : f.reason === 'invalid' ? 'invalid' : '—'}
    </td>
  );
}

/** A minimal line chart of one series; gaps (missing snapshots) break the line. */
function Sparkline({ points, label }: { points: { ts: number; value: number | null }[]; label: string }) {
  const known = points.filter((p): p is { ts: number; value: number } => p.value !== null);
  if (known.length < 2) return <span className="muted small">not enough history</span>;
  const w = 160;
  const h = 32;
  const t0 = points[0]!.ts;
  const t1 = points.at(-1)!.ts;
  const lo = Math.min(...known.map((p) => p.value));
  const hi = Math.max(...known.map((p) => p.value));
  const x = (ts: number) => ((ts - t0) / Math.max(t1 - t0, 1)) * w;
  const y = (val: number) => (hi === lo ? h / 2 : h - ((val - lo) / (hi - lo)) * (h - 4) - 2);
  const segments: string[] = [];
  let current = '';
  for (const p of points) {
    if (p.value === null) {
      if (current) segments.push(current);
      current = '';
      continue;
    }
    current += `${current ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`;
  }
  if (current) segments.push(current);
  const first = known[0]!.value;
  const last = known.at(-1)!.value;
  const tone = last > first ? 'var(--pos)' : last < first ? 'var(--neg)' : 'var(--muted)';
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={label}>
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke={tone} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

function HistoryRow({ s }: { s: AssetHistorySeries }) {
  const first = s.points.find((p) => p.openInterest !== null)?.openInterest ?? null;
  const last = [...s.points].reverse().find((p) => p.openInterest !== null)?.openInterest ?? null;
  return (
    <tr>
      <td>
        {EXCHANGE_NAMES[s.exchange]} <span className="muted">{s.symbol}</span>
      </td>
      <td>
        <Sparkline
          points={s.points.map((p) => ({ ts: p.ts, value: p.mark }))}
          label={`${s.symbol} mark price`}
        />
      </td>
      <td>
        <Sparkline
          points={s.points.map((p) => ({ ts: p.ts, value: p.openInterest }))}
          label={`${s.symbol} open interest`}
        />
      </td>
      <td className="num small muted">
        {first !== null && last !== null ? `${formatCompact(first)} → ${formatCompact(last)}` : '—'}
      </td>
    </tr>
  );
}

/** Everything about one coin: live values on every exchange, its signals, and a day of history. */
export function AssetDrawer({
  asset,
  onClose,
  onUnauthorized,
  onTerminal,
}: {
  asset: string;
  onClose: () => void;
  onUnauthorized: () => void;
  /** Opens the instrument in the terminal. */
  onTerminal: (exchange: ExchangeId, symbol: string) => void;
}) {
  const now = useNow();
  const fetchAsset = useCallback(() => api.asset(asset), [asset]);
  const res = useTopic<AssetDetailResponse>(`asset:${asset}`, fetchAsset, 3_000, onUnauthorized);
  const d = res.data?.asset === asset ? res.data : null;
  const name = d?.universe ? `${d.universe.name} (${asset})` : asset;

  return (
    <Drawer title={name} onClose={onClose}>
      {!d ? (
        <div className="empty">{res.error ?? 'Loading…'}</div>
      ) : (
        <>
          <dl className="facts pad">
            <div>
              <dt>Universe rank</dt>
              <dd>{d.universe ? `#${d.universe.rank}` : 'not in the monitored universe'}</dd>
            </div>
            <div>
              <dt>Market cap rank</dt>
              <dd>{d.universe?.marketCapRank ?? '—'}</dd>
            </div>
            <div>
              <dt>Market cap</dt>
              <dd>{d.universe?.marketCapUsd ? `$${formatCompact(d.universe.marketCapUsd)}` : '—'}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatWhen(d.ts)}</dd>
            </div>
          </dl>
          {d.staleExchanges.length > 0 && (
            <p className="small warn pad">
              No fresh data from {d.staleExchanges.map((e) => EXCHANGE_NAMES[e]).join(', ')}: values are shown
              as stale.
            </p>
          )}
          <h3 className="section-title">Exchanges</h3>
          {d.rows.length === 0 ? (
            <div className="empty">No exchange streams this asset.</div>
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Exchange</th>
                    <th aria-label="Chart" />
                    <th className="num">Last</th>
                    <th className="num">Mark</th>
                    <th className="num" title="Hyperliquid publishes an oracle price instead of an index">
                      Index / oracle
                    </th>
                    <th className="num">Bid</th>
                    <th className="num">Ask</th>
                    <th className="num">Funding</th>
                    <th className="num">Int.</th>
                    <th className="num">Next fund.</th>
                    <th className="num" title="One side, base units">
                      OI (base)
                    </th>
                    <th className="num">24h turnover</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => {
                    const funding = v(r.fields.fundingRate);
                    return (
                      <tr key={`${r.exchange}:${r.symbol}`}>
                        <td>
                          {r.instrument ? (
                            <a
                              href={r.instrument.url}
                              target="_blank"
                              rel="noreferrer"
                              title={`×${r.instrument.multiplier} per base unit, quote ${r.instrument.quote}`}
                            >
                              {EXCHANGE_NAMES[r.exchange]} {r.symbol}
                            </a>
                          ) : (
                            `${EXCHANGE_NAMES[r.exchange]} ${r.symbol}`
                          )}
                          {r.instrument && r.instrument.multiplier !== 1 && (
                            <span className="muted small"> ×{r.instrument.multiplier}</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="link small"
                            onClick={() => onTerminal(r.exchange, r.symbol)}
                            title={`Open ${r.symbol} on ${EXCHANGE_NAMES[r.exchange]} in the terminal`}
                          >
                            Chart
                          </button>
                        </td>
                        <Cell f={r.fields.last} format={formatPrice} />
                        <Cell f={r.fields.mark} format={formatPrice} />
                        <Cell f={r.fields.index} format={formatPrice} />
                        <Cell f={r.fields.bid} format={formatPrice} />
                        <Cell f={r.fields.ask} format={formatPrice} />
                        <td
                          className={`num ${funding === null ? 'muted' : funding > 0 ? 'pos' : funding < 0 ? 'neg' : ''}`}
                        >
                          {funding === null ? '—' : formatRate(funding)}
                        </td>
                        <Cell f={r.fields.fundingIntervalHours} format={(x) => `${x}h`} />
                        <Cell f={r.fields.nextFundingTime} format={(x) => formatCountdown(x, now)} />
                        <Cell f={r.fields.openInterest} format={formatCompact} />
                        <Cell f={r.fields.turnover24h} format={formatCompact} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted pad">
            Prices are per contract base unit: divide by the multiplier (×1000 etc.) for the price of one
            coin.
          </p>

          <h3 className="section-title">Open signals ({d.active.length})</h3>
          {d.active.length === 0 ? (
            <div className="empty small">No open signals for {asset}.</div>
          ) : (
            d.active.map((s) => (
              <details key={s.id || s.key} className="signal-item">
                <summary>
                  <span className="muted">{SCANNERS.find((x) => x.id === s.scanner)?.name}</span>{' '}
                  <b className={directionTone(s.direction)}>{headline(s)}</b> {s.title}
                </summary>
                <SignalDetails signal={s} />
              </details>
            ))
          )}

          <h3 className="section-title">Recent resolved signals</h3>
          {d.recent.length === 0 ? (
            <div className="empty small">None recorded.</div>
          ) : (
            <ul className="updates small">
              {d.recent.map((s) => (
                <li key={s.id || s.key} title={s.title}>
                  <span className="update-kind">
                    {SCANNERS.find((x) => x.id === s.scanner)?.name ?? s.scanner}
                  </span>
                  <span className="update-text">
                    <b className={directionTone(s.direction)}>{headline(s)}</b> {s.title}
                  </span>
                  <span className="muted">{formatWhen(s.resolvedAt ?? s.lastSeenAt)}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="section-title">
            Last {d.historyHours} h{' '}
            <span className="muted small">(every {d.historyStepMinutes} min, minute snapshots)</span>
          </h3>
          {d.history.length === 0 ? (
            <div className="empty small">No snapshots stored for this asset yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Exchange</th>
                    <th>Mark price</th>
                    <th>Open interest</th>
                    <th className="num">OI first → last</th>
                  </tr>
                </thead>
                <tbody>
                  {d.history.map((s) => (
                    <HistoryRow key={`${s.exchange}:${s.symbol}`} s={s} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted disclaimer pad">Analytical data, not a trading recommendation.</p>
        </>
      )}
    </Drawer>
  );
}
