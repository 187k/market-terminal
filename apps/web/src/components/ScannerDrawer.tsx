import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EXCHANGE_IDS,
  EXCHANGE_NAMES,
  type ExchangeId,
  type ScannerInfo,
  type SignalDto,
} from '@mip/core/types';
import { api, ApiError } from '../api';
import { applyFilters, type WindowFilters } from '../filters';
import { formatDuration, formatWhen } from '../format';
import { commonColumns, SCANNER_COLUMNS, type Column } from '../signalView';
import { Drawer } from './Drawer';
import { FilterBar } from './FilterBar';
import { SettingsForm } from './SettingsForm';
import { SignalDetails } from './SignalDetails';
import { SortableTable } from './SortableTable';

export type ScannerTab = 'active' | 'history' | 'settings';

const PAGE = 50;

function History({
  scanner,
  columns,
  onUnauthorized,
}: {
  scanner: ScannerInfo;
  columns: Column<SignalDto>[];
  onUnauthorized: () => void;
}) {
  const [exchange, setExchange] = useState<ExchangeId | ''>('');
  const [asset, setAsset] = useState('');
  const [query, setQuery] = useState<{ exchange: ExchangeId | ''; asset: string }>({
    exchange: '',
    asset: '',
  });
  const [rows, setRows] = useState<SignalDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (before: number | undefined, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.signalHistory({
          scanner: scanner.id,
          limit: PAGE,
          ...(query.exchange ? { exchange: query.exchange } : {}),
          ...(query.asset ? { asset: query.asset } : {}),
          ...(before ? { before } : {}),
        });
        setRows((r) => (replace ? res.signals : [...r, ...res.signals]));
        setDone(res.signals.length < PAGE);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [scanner.id, query, onUnauthorized],
  );

  useEffect(() => {
    void load(undefined, true);
  }, [load]);

  const historyColumns = useMemo<Column<SignalDto>[]>(
    () => [
      ...columns,
      {
        key: 'resolved',
        label: 'Resolved',
        numeric: true,
        sortValue: (s) => s.resolvedAt,
        render: (s) => formatWhen(s.resolvedAt),
      },
      {
        key: 'lasted',
        label: 'Lasted',
        numeric: true,
        sortValue: (s) => (s.resolvedAt ?? s.lastSeenAt) - s.firstSeenAt,
        render: (s) => formatDuration((s.resolvedAt ?? s.lastSeenAt) - s.firstSeenAt),
      },
    ],
    [columns],
  );

  return (
    <>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ exchange, asset: asset.trim().toUpperCase() });
        }}
      >
        <label className="small muted">
          Exchange{' '}
          <select value={exchange} onChange={(e) => setExchange(e.target.value as ExchangeId | '')}>
            <option value="">All</option>
            {EXCHANGE_IDS.map((ex) => (
              <option key={ex} value={ex}>
                {EXCHANGE_NAMES[ex]}
              </option>
            ))}
          </select>
        </label>
        <input
          className="search"
          type="search"
          placeholder="Asset, e.g. BTC"
          aria-label="Asset code"
          value={asset}
          onChange={(e) => setAsset(e.target.value)}
        />
        <button type="submit" className="btn">
          Apply
        </button>
        <span className="small muted">
          {rows.length} resolved signal{rows.length === 1 ? '' : 's'} loaded, newest first
        </span>
      </form>
      {error && <p className="small neg pad">{error}</p>}
      <SortableTable
        label={`${scanner.name} history`}
        columns={historyColumns}
        rows={rows}
        rowKey={(s) => s.id || s.key}
        onRowClick={(s) => setExpanded((k) => (k === (s.id || s.key) ? null : s.id || s.key))}
        expanded={expanded}
        renderExpanded={(s) => <SignalDetails signal={s} />}
        empty={loading ? 'Loading…' : 'No resolved signals match.'}
      />
      <div className="pad center">
        {!done && rows.length > 0 && (
          <button
            type="button"
            className="btn"
            disabled={loading}
            onClick={() => void load(rows.at(-1)?.firstSeenAt, false)}
          >
            {loading ? 'Loading…' : `Load ${PAGE} more`}
          </button>
        )}
        {done && rows.length > 0 && <span className="small muted">End of history.</span>}
      </div>
    </>
  );
}

/** Detailed view of one scanner: every open signal, the history, and the settings. */
export function ScannerDrawer({
  scanner,
  tab,
  onTab,
  active,
  filters,
  onFilters,
  onAsset,
  onClose,
  onUnauthorized,
}: {
  scanner: ScannerInfo;
  tab: ScannerTab;
  onTab: (t: ScannerTab) => void;
  active: SignalDto[];
  filters: WindowFilters;
  onFilters: (f: WindowFilters) => void;
  onAsset: (asset: string) => void;
  onClose: () => void;
  onUnauthorized: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const columns = useMemo(() => {
    const { lead, tail } = commonColumns(onAsset);
    return [...lead, ...SCANNER_COLUMNS[scanner.id], ...tail];
  }, [scanner.id, onAsset]);
  const { shown, unknown } = applyFilters(active, filters, scanner.id);
  const tabs: [ScannerTab, string][] = [
    ['active', `Active (${active.length})`],
    ['history', 'History'],
    ['settings', 'Settings'],
  ];

  return (
    <Drawer title={scanner.name} onClose={onClose}>
      <div className="tabs drawer-tabs" role="tablist" aria-label="View">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`tab ${tab === t ? 'tab-active' : ''}`}
            onClick={() => onTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'active' && (
        <>
          <FilterBar scanner={scanner.id} filters={filters} onChange={onFilters} />
          <p className="small muted pad">
            Showing {shown.length} of {active.length} open signals
            {unknown > 0 ? ` (${unknown} hidden: volume or size unknown)` : ''}. Click a row for details.
          </p>
          <SortableTable
            label={`${scanner.name} active signals`}
            columns={columns}
            rows={shown}
            rowKey={(s) => s.id || s.key}
            initialSort={{ key: 'first', dir: 'desc' }}
            onRowClick={(s) => setExpanded((k) => (k === (s.id || s.key) ? null : s.id || s.key))}
            expanded={expanded}
            renderExpanded={(s) => <SignalDetails signal={s} />}
            empty={active.length ? 'No open signals match the filters.' : 'No open signals right now.'}
          />
        </>
      )}
      {tab === 'history' && <History scanner={scanner} columns={columns} onUnauthorized={onUnauthorized} />}
      {tab === 'settings' && <SettingsForm scanner={scanner.id} onUnauthorized={onUnauthorized} />}
    </Drawer>
  );
}
