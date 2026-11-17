import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SCANNER_IDS,
  SCANNERS,
  type ConnectionEventDto,
  type ExchangeId,
  type LiveSignalsResponse,
  type ScannerId,
  type ScannersResponse,
  type SessionUser,
  type SignalDto,
  type SystemStatus,
} from '@mip/core/types';
import { api } from '../api';
import { NO_FILTERS, type WindowFilters } from '../filters';
import { formatAge, formatClock } from '../format';
import { RealtimeContext, useConnectionState, useNow, usePersistentState, useTopic } from '../hooks';
import { RealtimeConnection } from '../realtime';
import { AssetDrawer } from './AssetDrawer';
import { Badge } from './Badge';
import { EventsPanel } from './EventsPanel';
import { ExchangePanel } from './ExchangePanel';
import { MarketPanel } from './MarketPanel';
import { ScannerDrawer, type ScannerTab } from './ScannerDrawer';
import { ScannerWindow } from './ScannerWindow';

const DEFAULT_FILTERS = Object.fromEntries(SCANNER_IDS.map((id) => [id, NO_FILTERS])) as Record<
  ScannerId,
  WindowFilters
>;

const fetchEvents = () => api.events();

function ConnectionBadge() {
  const state = useConnectionState();
  if (state === 'open')
    return (
      <Badge tone="pos" title="Updates are pushed over a WebSocket">
        live
      </Badge>
    );
  return (
    <Badge
      tone={state === 'connecting' ? 'info' : 'warn'}
      title="The WebSocket is not connected; data is polled every few seconds until it reconnects"
    >
      {state === 'connecting' ? 'connecting' : 'polling'}
    </Badge>
  );
}

function Dashboard({ user, onLoggedOut }: { user: SessionUser; onLoggedOut: () => void }) {
  const status = useTopic<SystemStatus>('status', api.status, 2_000, onLoggedOut);
  const events = useTopic<ConnectionEventDto[]>('events', fetchEvents, 5_000, onLoggedOut);
  const scanners = useTopic<ScannersResponse>('scanners', api.scanners, 2_000, onLoggedOut);
  const signals = useTopic<LiveSignalsResponse>('signals', api.liveSignals, 2_000, onLoggedOut);
  const now = useNow();
  const [filters, setFilters] = usePersistentState('mip.filters.v1', DEFAULT_FILTERS);
  const [view, setView] = useState<{ id: ScannerId; tab: ScannerTab } | null>(null);
  const [asset, setAsset] = useState<string | null>(null);

  const processes = status.data?.processes ?? [];
  const collectorAlive = processes.some((p) => p.name === 'collector' && p.alive);
  // null until the first status response: "not loaded yet" must not read as "process down".
  const engineAlive = status.data ? processes.some((p) => p.name === 'engine' && p.alive) : null;
  const streamingKey = (status.data?.exchanges ?? [])
    .filter((e) => (e.data?.tracked ?? 0) > 0)
    .map((e) => e.exchange)
    .join(',');
  const streaming = useMemo(
    () => (streamingKey ? (streamingKey.split(',') as ExchangeId[]) : []),
    [streamingKey],
  );
  const byScanner = useMemo(() => {
    const out = {} as Record<ScannerId, { active: SignalDto[]; recent: SignalDto[] }>;
    for (const id of SCANNER_IDS) out[id] = { active: [], recent: [] };
    for (const s of signals.data?.active ?? []) out[s.scanner]?.active.push(s);
    for (const s of signals.data?.recent ?? []) out[s.scanner]?.recent.push(s);
    return out;
  }, [signals.data]);

  const openAsset = useCallback((a: string) => setAsset(a), []);
  const setScannerFilters = (id: ScannerId) => (f: WindowFilters) => setFilters({ ...filters, [id]: f });

  const logout = async () => {
    await api.logout().catch(() => undefined);
    onLoggedOut();
  };

  const viewed = view ? SCANNERS.find((s) => s.id === view.id) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ◆
          </span>
          Market Intelligence
        </div>
        <div className="procs" aria-label="Process status">
          {processes.map((p) => (
            <Badge
              key={p.name}
              tone={p.alive ? 'pos' : 'neg'}
              title={
                p.alive ? `pid ${p.pid}, v${p.version}, seen ${formatAge(p.lastSeenAt, now)}` : 'no heartbeat'
              }
            >
              {p.name}
            </Badge>
          ))}
        </div>
        <div className="updated small">
          <ConnectionBadge />{' '}
          {status.error ? (
            <span className="neg">Connection problem: {status.error}</span>
          ) : (
            <span className="muted">Updated {formatClock(status.updatedAt)}</span>
          )}
        </div>
        <div className="user small">
          <span className="muted">{user.username}</span>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <main className="layout">
        <div className="scanners">
          {SCANNERS.map((s) => (
            <ScannerWindow
              key={s.id}
              scanner={s}
              status={scanners.data?.scanners.find((x) => x.id === s.id)}
              active={byScanner[s.id].active}
              recent={byScanner[s.id].recent}
              engineAlive={engineAlive}
              filters={filters[s.id] ?? NO_FILTERS}
              onFilters={setScannerFilters(s.id)}
              onOpen={(tab) => setView({ id: s.id, tab })}
              onAsset={openAsset}
            />
          ))}
        </div>
        <aside className="side">
          <ExchangePanel
            exchanges={status.data?.exchanges ?? []}
            updatedAt={status.data?.exchangesUpdatedAt ?? null}
            collectorAlive={status.data ? collectorAlive : null}
          />
          <EventsPanel events={events.data} error={events.error} />
        </aside>
        <div className="span-all">
          <MarketPanel exchanges={streaming} onUnauthorized={onLoggedOut} onAsset={openAsset} />
        </div>
      </main>

      {asset ? (
        <AssetDrawer asset={asset} onClose={() => setAsset(null)} onUnauthorized={onLoggedOut} />
      ) : view && viewed ? (
        <ScannerDrawer
          scanner={viewed}
          tab={view.tab}
          onTab={(tab) => setView({ id: view.id, tab })}
          active={byScanner[view.id].active}
          filters={filters[view.id] ?? NO_FILTERS}
          onFilters={setScannerFilters(view.id)}
          onAsset={openAsset}
          onClose={() => setView(null)}
          onUnauthorized={onLoggedOut}
        />
      ) : null}
    </div>
  );
}

/** Opens one WebSocket for the session; every panel reads its topics through it. */
export function DashboardPage({ user, onLoggedOut }: { user: SessionUser; onLoggedOut: () => void }) {
  const loggedOut = useRef(onLoggedOut);
  loggedOut.current = onLoggedOut;
  const stableLoggedOut = useCallback(() => loggedOut.current(), []);
  const [rt] = useState(() => new RealtimeConnection(() => loggedOut.current()));
  useEffect(() => {
    rt.start();
    return () => rt.stop();
  }, [rt]);
  return (
    <RealtimeContext.Provider value={rt}>
      <Dashboard user={user} onLoggedOut={stableLoggedOut} />
    </RealtimeContext.Provider>
  );
}
