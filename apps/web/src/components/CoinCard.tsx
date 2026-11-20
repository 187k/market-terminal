import { useId } from 'react';
import type { OverviewCoin, PerpSummary } from '@mip/core/types';
import { formatAge, formatSignedPct, formatUsd, formatUsdCompact } from '../format';
import { signTone } from '../signalView';

/**
 * A price series as a line with a fading area under it. The x axis is the point index:
 * CoinGecko's 7-day sparkline has no timestamps (roughly one point per hour).
 */
export function AreaSpark({
  values,
  label,
  fill = true,
  className = 'area-spark',
}: {
  values: number[];
  label: string;
  fill?: boolean;
  className?: string;
}) {
  const id = useId();
  // A span, not a div: the chart also sits inside the card's <button>.
  if (values.length < 2)
    return <span className={`${className} area-spark-empty muted small`}>no chart data</span>;
  const w = 100;
  const h = 40;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => (hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4));
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
  const first = values[0]!;
  const last = values.at(-1)!;
  const tone = last > first ? 'var(--pos)' : last < first ? 'var(--neg)' : 'var(--muted)';
  return (
    <svg
      className={className}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
              <stop offset="100%" stopColor={tone} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line}L${w},${h}L0,${h}Z`} fill={`url(#${id})`} stroke="none" />
        </>
      )}
      <path d={line} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A change in percent as a coloured pill with an arrow: "↓ −7.16 %". */
export function ChangePill({ value, title }: { value: number | null; title?: string }) {
  if (value === null)
    return (
      <span className="chg-pill" title={title}>
        —
      </span>
    );
  const tone = signTone(value);
  return (
    <span className={`chg-pill chg-${tone || 'flat'}`} title={title}>
      {value > 0 ? '↑' : value < 0 ? '↓' : ''} {formatSignedPct(value)}
    </span>
  );
}

const fundingText = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(3)} %`;

/** One of the large coin cards: CoinGecko price, 24 h change, 7-day chart, and perpetual figures. */
export function CoinCard({
  coin,
  perps,
  fetchedAt,
  stale,
  now,
  onOpen,
}: {
  coin: OverviewCoin;
  perps: PerpSummary | null;
  fetchedAt: number | null;
  stale: boolean;
  now: number;
  onOpen: (asset: string) => void;
}) {
  const s = coin.spot;
  const age = fetchedAt === null ? 'not fetched yet' : formatAge(fetchedAt, now);
  const dotTitle =
    s === null
      ? 'CoinGecko returned no figures for this coin'
      : stale
        ? `CoinGecko figures are out of date (fetched ${age})`
        : `CoinGecko figures fetched ${age}`;
  return (
    <button
      type="button"
      className="coin-card"
      onClick={() => onOpen(coin.asset)}
      title={`Open ${coin.name} in the coin view`}
    >
      <span className="coin-head">
        <span>
          <span className="coin-name">{coin.name}</span>
          <span className="coin-ticker muted">
            {coin.asset}
            {s?.marketCapRank ? ` · #${s.marketCapRank}` : ''}
          </span>
        </span>
        <span className={`dot ${s === null ? 'dot-off' : stale ? 'dot-warn' : 'dot-ok'}`} title={dotTitle} />
      </span>
      <span className={`coin-price ${stale ? 'warn' : ''}`}>
        {s?.priceUsd != null ? formatUsd(s.priceUsd) : '—'}
      </span>
      <span className="coin-change">
        <ChangePill value={s?.change24hPct ?? null} title="Price change over 24 h (CoinGecko)" />
        {s?.change7dPct != null && (
          <span className={`small ${signTone(s.change7dPct)}`} title="Price change over 7 days (CoinGecko)">
            7d {formatSignedPct(s.change7dPct, 1)}
          </span>
        )}
      </span>
      <AreaSpark values={s?.sparkline7d ?? []} label={`${coin.name} price over 7 days`} />
      <span className="coin-stats small">
        <span title="Market capitalisation (CoinGecko)">
          <span className="muted">MCap</span>{' '}
          {s?.marketCapUsd != null ? formatUsdCompact(s.marketCapUsd) : '—'}
        </span>
        <span title="Spot trading volume over 24 h, all exchanges CoinGecko tracks">
          <span className="muted">Vol</span>{' '}
          {s?.volume24hUsd != null ? formatUsdCompact(s.volume24hUsd) : '—'}
        </span>
        <span
          title={
            perps?.fundingLow && perps.fundingHigh
              ? `Median funding over 24 h across ${perps.venues.length} exchanges; range ${fundingText(perps.fundingLow.rate24hPct)} to ${fundingText(perps.fundingHigh.rate24hPct)}`
              : 'Median perpetual funding rate normalised to 24 h, monitored exchanges'
          }
        >
          <span className="muted">Fund</span>{' '}
          <span className={signTone(perps?.funding24hPct)}>
            {perps?.funding24hPct != null ? fundingText(perps.funding24hPct) : '—'}
          </span>
        </span>
        <span title="Perpetual open interest (one side) summed over the monitored exchanges, and its 24 h change in coins">
          <span className="muted">OI</span>{' '}
          {perps?.openInterestUsd != null ? formatUsdCompact(perps.openInterestUsd) : '—'}
          {perps?.oiChange24hPct != null && (
            <span className={signTone(perps.oiChange24hPct)}>
              {' '}
              {formatSignedPct(perps.oiChange24hPct, 1)}
            </span>
          )}
        </span>
      </span>
      <span className="coin-foot muted small">
        <span>coingecko · 7d</span>
        <span className={stale ? 'warn' : ''}>{age}</span>
      </span>
    </button>
  );
}
