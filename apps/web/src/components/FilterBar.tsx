import { EXCHANGE_IDS, EXCHANGE_NAMES, type ScannerId } from '@mip/core/types';
import { filtersActive, NO_FILTERS, type WindowFilters } from '../filters';
import { SIZE_METRIC } from '../signalView';

const toNumber = (v: string): number | null => {
  const n = Number(v);
  return v.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n;
};

/** View filters of one scanner window: exchange, trading pair, volume and the scanner's size figure. */
export function FilterBar({
  scanner,
  filters,
  onChange,
}: {
  scanner: ScannerId;
  filters: WindowFilters;
  onChange: (f: WindowFilters) => void;
}) {
  const size = SIZE_METRIC[scanner];
  const toggle = (ex: (typeof EXCHANGE_IDS)[number]) =>
    onChange({
      ...filters,
      exchanges: filters.exchanges.includes(ex)
        ? filters.exchanges.filter((e) => e !== ex)
        : EXCHANGE_IDS.filter((e) => e === ex || filters.exchanges.includes(e)),
    });
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <div className="chips" aria-label="Exchanges">
        {EXCHANGE_IDS.map((ex) => (
          <button
            key={ex}
            type="button"
            className={`chip ${filters.exchanges.includes(ex) ? 'chip-on' : ''}`}
            aria-pressed={filters.exchanges.includes(ex)}
            onClick={() => toggle(ex)}
          >
            {EXCHANGE_NAMES[ex]}
          </button>
        ))}
      </div>
      <div className="filter-inputs">
        <input
          type="search"
          className="search"
          placeholder="Pair, e.g. BTC"
          aria-label="Trading pair"
          value={filters.pair}
          onChange={(e) => onChange({ ...filters, pair: e.target.value })}
        />
        <input
          type="number"
          min={0}
          className="search"
          placeholder="Min 24h turnover, $"
          aria-label="Minimum 24 hour turnover in dollars"
          title="Minimum 24 h turnover; cross-exchange signals use the smaller leg"
          value={filters.minTurnover ?? ''}
          onChange={(e) => onChange({ ...filters, minTurnover: toNumber(e.target.value) })}
        />
        {size && (
          <input
            type="number"
            min={0}
            className="search"
            placeholder={size.label}
            aria-label={size.label}
            title={size.title}
            value={filters.minSize ?? ''}
            onChange={(e) => onChange({ ...filters, minSize: toNumber(e.target.value) })}
          />
        )}
        {filtersActive(filters) && (
          <button type="button" className="btn btn-ghost small" onClick={() => onChange(NO_FILTERS)}>
            Clear
          </button>
        )}
      </div>
      <p className="small muted filter-note">
        Filters change this view only. Detection and Telegram use the scanner settings.
      </p>
    </div>
  );
}
