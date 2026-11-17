import type { ReactNode } from 'react';
import {
  EXCHANGE_NAMES,
  type ExchangeId,
  type FairPriceData,
  type FundingData,
  type OpenInterestData,
  type ScannerId,
  type SignalDto,
  type SpreadData,
  type TwapData,
} from '@mip/core/types';
import {
  formatCompact,
  formatDuration,
  formatPrice,
  formatRate,
  formatSignedPct,
  formatWhen,
} from './format';

/**
 * Presentation of signals per scanner: which exchanges, volume and size a signal stands for
 * (for the window filters), its headline figure and its table columns. Reads only what the
 * engine stored in `data`; older signals may lack fields, so every read tolerates absence.
 */

const fair = (s: SignalDto) => s.data as Partial<FairPriceData>;
const oi = (s: SignalDto) => s.data as Partial<OpenInterestData>;
const funding = (s: SignalDto) => s.data as Partial<FundingData>;
const spread = (s: SignalDto) => s.data as Partial<SpreadData>;
const twap = (s: SignalDto) => s.data as Partial<TwapData>;

const minOf = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter((v): v is number => typeof v === 'number');
  return known.length ? Math.min(...known) : null;
};

/** Exchanges a signal concerns: one for single-venue signals, both legs for cross-exchange ones. */
export function exchangesOf(s: SignalDto): ExchangeId[] {
  if (s.exchange) return [s.exchange];
  if (s.scanner === 'spread') {
    const d = spread(s);
    return [d.buy?.exchange, d.sell?.exchange].filter((e): e is ExchangeId => !!e);
  }
  if (s.scanner === 'funding') {
    const d = funding(s);
    const legs = d.kind === 'arbitrage' ? [d.long, d.short] : [d.leg];
    return legs.map((l) => l?.exchange).filter((e): e is ExchangeId => !!e);
  }
  return [];
}

/** 24 h turnover behind a signal; for cross-exchange signals the smaller of the legs. */
export function turnoverOf(s: SignalDto): number | null {
  switch (s.scanner) {
    case 'fair-price':
      return fair(s).turnover24h ?? null;
    case 'open-interest':
      return oi(s).turnover24h ?? null;
    case 'twap':
      return twap(s).turnover24h ?? null;
    case 'spread':
      return minOf([spread(s).buy?.turnover24h, spread(s).sell?.turnover24h]);
    case 'funding': {
      const d = funding(s);
      return minOf(
        d.kind === 'arbitrage' ? [d.long?.turnover24h, d.short?.turnover24h] : [d.leg?.turnover24h],
      );
    }
  }
}

export interface SizeMetric {
  label: string;
  title: string;
  value: (s: SignalDto) => number | null;
}

/** The scanner's own liquidity / size figure for the "minimum size" filter (none for funding and spreads). */
export const SIZE_METRIC: Record<ScannerId, SizeMetric | null> = {
  'fair-price': {
    label: 'Min top of book, $',
    title: 'Notional at the best level on the side you would take',
    value: (s) => fair(s).topOfBookUsd ?? null,
  },
  'open-interest': {
    label: 'Min open interest, $',
    title: 'Current open interest × mark price',
    value: (s) => oi(s).openInterestUsd ?? null,
  },
  funding: null,
  spread: null,
  twap: {
    label: 'Min executed, $',
    title: 'Volume executed by the detected pattern so far',
    value: (s) => twap(s).executedNotional ?? null,
  },
};

/** Primary figure of a signal for compact lists. */
export function headline(s: SignalDto): string {
  switch (s.scanner) {
    case 'fair-price':
      return formatSignedPct(s.value, 2);
    case 'open-interest':
      return `OI ${formatSignedPct(s.value, 1)}`;
    case 'funding':
      return `${s.value.toFixed(3)} %/24h`;
    case 'spread':
      return `net ${s.value.toFixed(2)} %`;
    case 'twap':
      return `$${Math.round(s.value).toLocaleString('en-US')}`;
  }
}

/** Green for long / buy / rising OI / positive funding, red for the opposite. */
export function directionTone(direction: string | null): string {
  if (!direction) return '';
  if (/^(LONG|BUY|OI_UP|UP|POSITIVE)/.test(direction)) return 'pos';
  if (/^(SHORT|SELL|OI_DOWN|DOWN|NEGATIVE)/.test(direction)) return 'neg';
  return '';
}

export const signTone = (v: number | null | undefined): string =>
  typeof v !== 'number' || v === 0 ? '' : v > 0 ? 'pos' : 'neg';

export const exName = (e: string | null | undefined): string =>
  e ? (EXCHANGE_NAMES[e as ExchangeId] ?? e) : '—';

const dash = '—';
const num = (v: number | null | undefined, f: (n: number) => string): string =>
  typeof v === 'number' && Number.isFinite(v) ? f(v) : dash;

/** One table column: header, optional sort value, and how a cell renders. */
export interface Column<T> {
  key: string;
  label: string;
  title?: string;
  numeric?: boolean;
  sortValue?: (row: T) => number | string | null;
  render: (row: T) => ReactNode;
}

const pctCell = (v: number | null | undefined, digits = 2) => (
  <span className={signTone(v)}>{num(v, (n) => formatSignedPct(n, digits))}</span>
);

/** Scanner-specific columns of the detail tables (shared by Active and History). */
export const SCANNER_COLUMNS: Record<ScannerId, Column<SignalDto>[]> = {
  'fair-price': [
    {
      key: 'dev',
      label: 'Deviation',
      title: '(last − mark) / mark × 100; below mark = LONG, above = SHORT',
      numeric: true,
      sortValue: (s) => Math.abs(s.value),
      render: (s) => pctCell(s.value),
    },
    { key: 'last', label: 'Last', numeric: true, render: (s) => num(fair(s).last, formatPrice) },
    { key: 'mark', label: 'Mark', numeric: true, render: (s) => num(fair(s).mark, formatPrice) },
    {
      key: 'fvi',
      label: 'Fair vs index',
      title: '(mark − index) / index × 100 (oracle on Hyperliquid)',
      numeric: true,
      sortValue: (s) => fair(s).fairVsIndexPct ?? null,
      render: (s) => pctCell(fair(s).fairVsIndexPct),
    },
    {
      key: 'spr',
      label: 'Book spread',
      numeric: true,
      sortValue: (s) => fair(s).spreadPct ?? null,
      render: (s) => num(fair(s).spreadPct, (n) => `${n.toFixed(2)} %`),
    },
    {
      key: 'tob',
      label: 'Top of book',
      numeric: true,
      sortValue: (s) => fair(s).topOfBookUsd ?? null,
      render: (s) => num(fair(s).topOfBookUsd, (n) => `$${formatCompact(n)}`),
    },
    {
      key: 'turn',
      label: '24h turnover',
      numeric: true,
      sortValue: turnoverOf,
      render: (s) => num(turnoverOf(s), formatCompact),
    },
    {
      key: 'risk',
      label: 'Risk',
      sortValue: (s) => ({ low: 0, medium: 1, high: 2 })[fair(s).risk?.level ?? 'low'],
      render: (s) => <RiskText risk={fair(s).risk} />,
    },
  ],
  'open-interest': [
    {
      key: 'chg',
      label: 'OI change',
      title: 'Change of open interest (base units) over the window',
      numeric: true,
      sortValue: (s) => Math.abs(s.value),
      render: (s) => pctCell(s.value, 1),
    },
    { key: 'win', label: 'Window', render: (s) => oi(s).primaryWindow ?? dash },
    {
      key: 'chgUsd',
      label: 'Change, $',
      numeric: true,
      sortValue: (s) => {
        const d = oi(s);
        const w = d.primaryWindow && d.windows?.[d.primaryWindow];
        return w && w.available ? w.changeUsd : null;
      },
      render: (s) => {
        const d = oi(s);
        const w = d.primaryWindow && d.windows?.[d.primaryWindow];
        return w && w.available ? (
          <span className={signTone(w.changeUsd)}>${formatCompact(w.changeUsd)}</span>
        ) : (
          dash
        );
      },
    },
    {
      key: 'price',
      label: 'Price change',
      numeric: true,
      render: (s) => {
        const d = oi(s);
        const w = d.primaryWindow && d.windows?.[d.primaryWindow];
        return w && w.available ? pctCell(w.priceChangePct) : dash;
      },
    },
    {
      key: 'oiUsd',
      label: 'OI, $',
      numeric: true,
      sortValue: (s) => oi(s).openInterestUsd ?? null,
      render: (s) => num(oi(s).openInterestUsd, formatCompact),
    },
    {
      key: 'turn',
      label: '24h turnover',
      numeric: true,
      sortValue: turnoverOf,
      render: (s) => num(turnoverOf(s), formatCompact),
    },
  ],
  funding: [
    {
      key: 'kind',
      label: 'Type',
      render: (s) => (funding(s).kind === 'arbitrage' ? 'Difference' : 'Extreme'),
    },
    {
      key: 'val',
      label: '24h',
      title: 'Extreme: funding normalised to 24 h. Difference: highest minus lowest 24 h funding.',
      numeric: true,
      sortValue: (s) => Math.abs(s.value),
      render: (s) => <span className={signTone(s.value)}>{s.value.toFixed(3)} %</span>,
    },
    {
      key: 'legs',
      label: 'Exchanges',
      render: (s) => {
        const d = funding(s);
        if (d.kind === 'arbitrage')
          return (
            <>
              long {exName(d.long?.exchange)} <span className="muted">{num(d.long?.rate, formatRate)}</span> /
              short {exName(d.short?.exchange)}{' '}
              <span className="muted">{num(d.short?.rate, formatRate)}</span>
            </>
          );
        return (
          <>
            {exName(d.leg?.exchange)} <span className="muted">{num(d.leg?.rate, formatRate)}</span>
            {d.leg?.intervalHours ? <span className="muted"> / {d.leg.intervalHours}h</span> : null}
          </>
        );
      },
    },
    {
      key: 'turn',
      label: 'Min 24h turnover',
      numeric: true,
      sortValue: turnoverOf,
      render: (s) => num(turnoverOf(s), formatCompact),
    },
  ],
  spread: [
    {
      key: 'route',
      label: 'Buy → sell',
      render: (s) => (
        <>
          {exName(spread(s).buy?.exchange)} → {exName(spread(s).sell?.exchange)}
        </>
      ),
    },
    {
      key: 'gross',
      label: 'Gross',
      title: 'Best bid of the dearer venue vs best ask of the cheaper one',
      numeric: true,
      sortValue: (s) => spread(s).grossPct ?? null,
      render: (s) => num(spread(s).grossPct, (n) => `${n.toFixed(2)} %`),
    },
    {
      key: 'net',
      label: 'Net',
      title: 'After both taker fees, VWAP slippage and funding over the holding period',
      numeric: true,
      sortValue: (s) => s.value,
      render: (s) => pctCell(s.value),
    },
    {
      key: 'profit',
      label: 'Net profit',
      numeric: true,
      sortValue: (s) => spread(s).breakdown?.netProfit ?? null,
      render: (s) => (
        <span className={signTone(spread(s).breakdown?.netProfit)}>
          {num(spread(s).breakdown?.netProfit, (n) => `$${n.toFixed(2)}`)}
          <span className="muted"> on {num(spread(s).positionUsd, (n) => `$${formatCompact(n)}`)}</span>
        </span>
      ),
    },
    {
      key: 'prelim',
      label: 'Quality',
      render: (s) =>
        (spread(s).preliminary?.length ?? 0) > 0 ? (
          <span className="warn" title={spread(s).preliminary?.join('; ')}>
            preliminary
          </span>
        ) : (
          <span className="muted">full</span>
        ),
    },
    {
      key: 'turn',
      label: 'Min 24h turnover',
      numeric: true,
      sortValue: turnoverOf,
      render: (s) => num(turnoverOf(s), formatCompact),
    },
  ],
  twap: [
    {
      key: 'kind',
      label: 'Source',
      render: (s) =>
        twap(s).kind === 'confirmed' ? (
          <span className="badge badge-info" title="Reported by the exchange (Hyperliquid TWAP)">
            confirmed
          </span>
        ) : (
          <span className="badge badge-muted" title="Detected from trade patterns; may be wrong">
            heuristic
          </span>
        ),
    },
    {
      key: 'exec',
      label: 'Executed',
      numeric: true,
      sortValue: (s) => s.value,
      render: (s) => `$${formatCompact(s.value)}`,
    },
    { key: 'slices', label: 'Slices', numeric: true, render: (s) => num(twap(s).slices, String) },
    {
      key: 'dur',
      label: 'Duration',
      numeric: true,
      render: (s) => {
        const d = twap(s);
        return typeof d.firstTs === 'number' && typeof d.lastTs === 'number'
          ? formatDuration(d.lastTs - d.firstTs)
          : dash;
      },
    },
    {
      key: 'conf',
      label: 'Confidence',
      numeric: true,
      sortValue: (s) => twap(s).confidence ?? null,
      render: (s) => num(twap(s).confidence, (n) => `${Math.round(n * 100)} %`),
    },
    { key: 'status', label: 'Status', render: (s) => twap(s).status ?? dash },
  ],
};

function RiskText({ risk }: { risk: FairPriceData['risk'] | undefined }) {
  if (!risk) return <>{dash}</>;
  const tone = risk.level === 'high' ? 'neg' : risk.level === 'medium' ? 'warn' : 'muted';
  return (
    <span className={tone} title={risk.reasons.join('; ') || 'no risk factors found'}>
      {risk.level}
    </span>
  );
}

/** Columns every scanner table starts / ends with. */
export function commonColumns(onAsset: (asset: string) => void): {
  lead: Column<SignalDto>[];
  tail: Column<SignalDto>[];
} {
  return {
    lead: [
      {
        key: 'asset',
        label: 'Asset',
        sortValue: (s) => s.asset,
        render: (s) => (
          <button type="button" className="link" onClick={() => onAsset(s.asset)} title="Open coin details">
            {s.asset}
          </button>
        ),
      },
      {
        key: 'ex',
        label: 'Exchange',
        sortValue: (s) => exchangesOf(s).join(','),
        render: (s) => (s.exchange ? exName(s.exchange) : exchangesOf(s).map(exName).join(' / ') || dash),
      },
      {
        key: 'dir',
        label: 'Direction',
        title: 'Analytical direction, not a trading recommendation',
        sortValue: (s) => s.direction ?? '',
        render: (s) => <span className={directionTone(s.direction)}>{s.direction ?? dash}</span>,
      },
    ],
    tail: [
      {
        key: 'first',
        label: 'Opened',
        numeric: true,
        sortValue: (s) => s.firstSeenAt,
        render: (s) => formatWhen(s.firstSeenAt),
      },
      {
        key: 'upd',
        label: 'Updates',
        numeric: true,
        sortValue: (s) => s.updates,
        render: (s) => s.updates,
      },
      {
        key: 'tg',
        label: 'Telegram',
        sortValue: (s) => s.telegram.state,
        render: (s) => (
          <span
            className={s.telegram.state === 'failed' ? 'neg' : s.telegram.state === 'sent' ? '' : 'muted'}
            title={s.telegram.detail ?? undefined}
          >
            {s.telegram.state}
          </span>
        ),
      },
    ],
  };
}
