import { EXCHANGE_NAMES, isExchangeId, type ConnectionEventDto } from '@mip/core/types';
import { formatClock } from '../format';
import { StateBadge } from './Badge';

export function EventsPanel({
  events,
  error,
}: {
  events: ConnectionEventDto[] | null;
  error: string | null;
}) {
  return (
    <section className="panel" aria-labelledby="events-title">
      <header className="panel-head">
        <h2 id="events-title">API &amp; WebSocket events</h2>
        {error && <span className="neg small">{error}</span>}
      </header>
      {events === null ? (
        <div className="empty">Loading…</div>
      ) : events.length === 0 ? (
        <div className="empty">No connection events recorded yet.</div>
      ) : (
        <ul className="events">
          {events.map((e) => (
            <li key={e.id}>
              <span className="mono muted">{formatClock(Date.parse(e.at))}</span>
              <span>{isExchangeId(e.exchange) ? EXCHANGE_NAMES[e.exchange] : e.exchange}</span>
              <span className="mono muted">{e.connection}</span>
              <StateBadge state={e.state} />
              {e.reason && <span className="event-reason">{e.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
