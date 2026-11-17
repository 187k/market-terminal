import { EXCHANGE_NAMES, type ConnectorHealth } from '@mip/core/types';
import { formatAge, formatClock } from '../format';
import { useNow } from '../hooks';
import { StateBadge } from './Badge';

/** Human-readable problems per exchange: failed starts, REST pauses after bans, last errors. */
function problemsOf(ex: ConnectorHealth, now: number): string[] {
  const out: string[] = [];
  if (ex.detail && ex.state !== 'disabled' && ex.state !== 'not_implemented') out.push(ex.detail);
  if (ex.rest?.pausedUntil && ex.rest.pausedUntil > now)
    out.push(`REST requests paused until ${formatClock(ex.rest.pausedUntil)} (exchange rate limit or ban)`);
  if (ex.rest?.lastError && ex.rest.lastErrorAt && now - ex.rest.lastErrorAt < 15 * 60_000)
    out.push(`REST error ${formatAge(ex.rest.lastErrorAt, now)}: ${ex.rest.lastError}`);
  for (const c of ex.connections)
    if (c.state !== 'open' && c.lastReason) out.push(`${c.name}: ${c.state}, ${c.lastReason}`);
  if (ex.data && ex.data.invalid > 0)
    out.push(`${ex.data.invalid} values rejected by validation since start`);
  return out;
}

export function ExchangePanel({
  exchanges,
  updatedAt,
  collectorAlive,
}: {
  exchanges: ConnectorHealth[];
  updatedAt: number | null;
  /** null until the first status response. */
  collectorAlive: boolean | null;
}) {
  const now = useNow();
  const problems = exchanges.flatMap((ex) => problemsOf(ex, now).map((p) => ({ ex: ex.exchange, p })));
  return (
    <section className="panel" aria-labelledby="exchanges-title">
      <header className="panel-head">
        <h2 id="exchanges-title">Exchange connections</h2>
        <span className="muted small">{updatedAt ? `reported ${formatAge(updatedAt, now)}` : ''}</span>
      </header>
      {exchanges.length === 0 ? (
        <div className="empty">
          {collectorAlive === null
            ? 'Loading…'
            : collectorAlive
              ? 'Waiting for the collector to report…'
              : 'Collector is not running, so there is no connection data.'}
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Exchange</th>
                  <th>State</th>
                  <th className="num" title="Instruments with fresh mark, bid and ask / instruments streamed">
                    Fresh
                  </th>
                  <th className="num">Conns</th>
                  <th className="num" title="Updates per second">
                    Upd/s
                  </th>
                  <th
                    className="num"
                    title="Exchange event time to local receive time (includes clock offset)"
                  >
                    Delay
                  </th>
                  <th className="num">Last msg</th>
                  <th className="num">Reconn.</th>
                </tr>
              </thead>
              <tbody>
                {exchanges.map((ex) => {
                  const open = ex.connections.filter((c) => c.state === 'open').length;
                  const lastMsg = ex.connections.reduce<number | null>(
                    (max, c) =>
                      c.lastMessageAt !== null && (max === null || c.lastMessageAt > max)
                        ? c.lastMessageAt
                        : max,
                    null,
                  );
                  const reconnects = ex.connections.reduce((n, c) => n + c.reconnects, 0);
                  const d = ex.data;
                  const title = problemsOf(ex, now).join(' · ') || undefined;
                  return (
                    <tr key={ex.exchange}>
                      <td>{EXCHANGE_NAMES[ex.exchange]}</td>
                      <td>
                        <StateBadge state={ex.state} {...(title ? { title } : {})} />
                      </td>
                      <td className={`num ${d && d.tracked > 0 && d.fresh < d.tracked ? 'warn' : ''}`}>
                        {d && d.tracked > 0 ? `${d.fresh}/${d.tracked}` : '—'}
                      </td>
                      <td className="num">
                        {ex.connections.length ? `${open}/${ex.connections.length}` : '—'}
                      </td>
                      <td className="num">{d && d.tracked > 0 ? d.updatesPerSec : '—'}</td>
                      <td className="num">{d?.latencyMs != null ? `${d.latencyMs} ms` : '—'}</td>
                      <td className="num">{formatAge(lastMsg, now)}</td>
                      <td className={`num ${reconnects > 0 ? 'warn' : ''}`}>
                        {ex.connections.length ? reconnects : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {problems.length > 0 && (
            <ul className="problems small" aria-label="API and WebSocket problems">
              {problems.map(({ ex, p }) => (
                <li key={`${ex}:${p}`}>
                  <strong>{EXCHANGE_NAMES[ex]}</strong> <span className="muted">{p}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
