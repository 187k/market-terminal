import { useMemo, useState, type ReactNode } from 'react';
import type { Column } from '../signalView';

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

function compare(a: number | string | null, b: number | string | null): number {
  // Unknown values always sort last, whichever direction.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** A table whose headers sort the rows; numeric columns start descending, text ascending. */
export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  initialSort,
  onRowClick,
  expanded,
  renderExpanded,
  empty,
  label,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  initialSort?: SortState;
  onRowClick?: (row: T) => void;
  /** Key of the row whose details are shown under it. */
  expanded?: string | null;
  renderExpanded?: (row: T) => ReactNode;
  empty?: ReactNode;
  label: string;
}) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const value = col.sortValue;
    const asc = sort.dir === 'asc';
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null || vb === null) return compare(va, vb);
      return asc ? compare(va, vb) : compare(vb, va);
    });
  }, [rows, columns, sort]);

  const toggle = (c: Column<T>) => {
    if (!c.sortValue) return;
    setSort((s) =>
      s?.key === c.key
        ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key: c.key, dir: c.numeric ? 'desc' : 'asc' },
    );
  };

  return (
    <div className="table-wrap">
      <table className="table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={c.numeric ? 'num' : undefined}
                  title={c.title}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      className={`sort ${active ? 'sort-active' : ''}`}
                      onClick={() => toggle(c)}
                    >
                      {c.label}
                      <span aria-hidden className="sort-arrow">
                        {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const key = rowKey(r);
            const open = expanded === key;
            return (
              <RowWithDetails
                key={key}
                open={open}
                colSpan={columns.length}
                details={open && renderExpanded ? renderExpanded(r) : null}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? 'num' : undefined}>
                    {c.render(r)}
                  </td>
                ))}
              </RowWithDetails>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <div className="empty">{empty ?? 'Nothing to show.'}</div>}
    </div>
  );
}

function RowWithDetails({
  children,
  open,
  colSpan,
  details,
  onClick,
}: {
  children: ReactNode;
  open: boolean;
  colSpan: number;
  details: ReactNode;
  onClick: (() => void) | undefined;
}) {
  return (
    <>
      <tr
        className={`${onClick ? 'clickable' : ''} ${open ? 'row-open' : ''}`}
        onClick={(e) => {
          // Buttons and links inside the row do their own thing.
          if ((e.target as HTMLElement).closest('a,button')) return;
          onClick?.();
        }}
      >
        {children}
      </tr>
      {open && details && (
        <tr className="row-details">
          <td colSpan={colSpan}>{details}</td>
        </tr>
      )}
    </>
  );
}
