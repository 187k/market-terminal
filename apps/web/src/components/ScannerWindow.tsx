import { useState } from 'react';
import type { ScannerInfo, ScannerStatusDto, SignalDto } from '@mip/core/types';
import { applyFilters, filtersActive, type WindowFilters } from '../filters';
import { formatAge } from '../format';
import { useNow } from '../hooks';
import { directionTone, exchangesOf, exName, headline } from '../signalView';
import { Badge, type Tone } from './Badge';
import { FilterBar } from './FilterBar';
import type { ScannerTab } from './ScannerDrawer';

function scannerState(
  status: ScannerStatusDto | undefined,
  engineAlive: boolean | null,
  now: number,
): { label: string; tone: Tone; title?: string } {
  if (engineAlive === null) return { label: 'loading', tone: 'muted' };
  if (!engineAlive) return { label: 'engine down', tone: 'neg', title: 'The engine process is not running' };
  if (!status) return { label: 'starting', tone: 'info' };
  if (!status.enabled)
    return { label: 'disabled', tone: 'muted', title: 'Switched off in the scanner settings' };
  if (status.error) return { label: 'error', tone: 'neg', title: status.error };
  if (status.lastRunAt === null) return { label: 'starting', tone: 'info' };
  if (now - status.lastRunAt > 120_000)
    return { label: 'stalled', tone: 'warn', title: `Last run ${formatAge(status.lastRunAt, now)}` };
  return {
    label: 'running',
    tone: 'pos',
    title: `Last run ${formatAge(status.lastRunAt, now)} in ${status.lastRunMs} ms`,
  };
}

const TELEGRAM_TONE: Record<string, Tone> = { ok: 'pos', disabled: 'muted', error: 'neg' };

/** Most significant first: the largest absolute figure (net spread and executed volume are signed / positive). */
const significance = (s: SignalDto) => (s.scanner === 'spread' ? s.value : Math.abs(s.value));

interface Update {
  ts: number;
  kind: 'opened' | 'updated' | 'resolved';
  signal: SignalDto;
}

/** Latest lifecycle events: new and changed open signals, and resolutions. */
function latestUpdates(active: SignalDto[], recent: SignalDto[], limit: number): Update[] {
  const out: Update[] = [];
  for (const s of active)
    out.push(
      s.updates > 0
        ? { ts: s.lastSeenAt, kind: 'updated', signal: s }
        : { ts: s.firstSeenAt, kind: 'opened', signal: s },
    );
  for (const s of recent) if (s.resolvedAt) out.push({ ts: s.resolvedAt, kind: 'resolved', signal: s });
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function SignalLine({ s, now, onAsset }: { s: SignalDto; now: number; onAsset: (a: string) => void }) {
  const where = s.exchange ? exName(s.exchange) : exchangesOf(s).map(exName).join(' / ');
  return (
    <li title={s.title}>
      <span className="signal-title">
        <button type="button" className="link" onClick={() => onAsset(s.asset)}>
          {s.asset}
        </button>{' '}
        <span className="muted">{where}</span>
      </span>
      <span className="signal-meta small">
        <b className={directionTone(s.direction)}>{headline(s)}</b>
        <span className="muted">
          {' '}
          · {s.direction ?? ''} · {formatAge(s.firstSeenAt, now)}
        </span>
      </span>
    </li>
  );
}

/**
 * One of the five working windows: status, key figures, the main open signals, the latest
 * updates, view filters, and buttons for the detailed view and the settings.
 */
export function ScannerWindow({
  scanner,
  status,
  active,
  recent,
  engineAlive,
  filters,
  onFilters,
  onOpen,
  onAsset,
}: {
  scanner: ScannerInfo;
  status: ScannerStatusDto | undefined;
  active: SignalDto[];
  recent: SignalDto[];
  engineAlive: boolean | null;
  filters: WindowFilters;
  onFilters: (f: WindowFilters) => void;
  onOpen: (tab: ScannerTab) => void;
  onAsset: (asset: string) => void;
}) {
  const now = useNow();
  const [showFilters, setShowFilters] = useState(false);
  const state = scannerState(status, engineAlive, now);
  const telegram = status?.telegram;
  const { shown, unknown } = applyFilters(active, filters, scanner.id);
  const top = [...shown].sort((a, b) => significance(b) - significance(a)).slice(0, 5);
  const updates = latestUpdates(shown, applyFilters(recent, filters, scanner.id).shown, 4);
  const filtered = filtersActive(filters);

  return (
    <section className="panel scanner" aria-labelledby={`scanner-${scanner.id}`}>
      <header className="panel-head">
        <h2 id={`scanner-${scanner.id}`}>{scanner.name}</h2>
        <Badge tone={state.tone} {...(state.title ? { title: state.title } : {})}>
          {state.label}
        </Badge>
      </header>
      <p className="scanner-summary">{scanner.summary}</p>
      <dl className="metrics">
        <div title={filtered ? 'Open signals matching the filters / all open signals' : 'Open signals'}>
          <dt>Active</dt>
          <dd>{status ? (filtered ? `${shown.length}/${active.length}` : active.length) : '—'}</dd>
        </div>
        <div title={status?.lastSignalAt ? `last ${formatAge(status.lastSignalAt, now)}` : undefined}>
          <dt>Signals 24h</dt>
          <dd>{status ? status.signals24h : '—'}</dd>
        </div>
        <div title="Instruments or assets checked in the last run">
          <dt>Checked</dt>
          <dd>{status ? status.evaluated : '—'}</dd>
        </div>
        <div>
          <dt>Telegram</dt>
          <dd>
            {telegram ? (
              <Badge
                tone={TELEGRAM_TONE[telegram.state] ?? 'muted'}
                {...(telegram.detail ? { title: telegram.detail } : {})}
              >
                {telegram.state}
              </Badge>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
      {status && status.warnings.length > 0 && (
        <ul className="scanner-warnings small">
          {status.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {showFilters && <FilterBar scanner={scanner.id} filters={filters} onChange={onFilters} />}

      <h3 className="section-title">Main signals</h3>
      {top.length === 0 ? (
        <div className="empty small">
          {!status
            ? 'Waiting for the engine…'
            : active.length > 0
              ? `No open signal matches the filters${unknown ? ` (${unknown} with unknown volume or size)` : ''}.`
              : `No open signals (${status.evaluated} checked in the last run).`}
        </div>
      ) : (
        <ul className="signals" aria-label={`${scanner.name} main signals`}>
          {top.map((s) => (
            <SignalLine key={s.id || s.key} s={s} now={now} onAsset={onAsset} />
          ))}
          {shown.length > top.length && (
            <li>
              <button type="button" className="link small" onClick={() => onOpen('active')}>
                +{shown.length - top.length} more in the detailed view
              </button>
            </li>
          )}
        </ul>
      )}

      <h3 className="section-title">Latest updates</h3>
      {updates.length === 0 ? (
        <div className="empty small">Nothing yet.</div>
      ) : (
        <ul className="updates small" aria-label={`${scanner.name} latest updates`}>
          {updates.map((u) => (
            <li key={`${u.kind}:${u.signal.id || u.signal.key}:${u.ts}`} title={u.signal.title}>
              <span className={`update-kind update-${u.kind}`}>{u.kind}</span>
              <span className="update-text">
                {u.signal.asset} <b className={directionTone(u.signal.direction)}>{headline(u.signal)}</b>
              </span>
              <span className="muted">{formatAge(u.ts, now)}</span>
            </li>
          ))}
        </ul>
      )}

      <footer className="panel-foot">
        <button
          type="button"
          className={`btn ${filtered ? 'btn-on' : ''}`}
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          Filters{filtered ? ' •' : ''}
        </button>
        <button type="button" className="btn" onClick={() => onOpen('settings')}>
          Settings
        </button>
        <button type="button" className="btn" onClick={() => onOpen('active')}>
          Details
        </button>
      </footer>
    </section>
  );
}
