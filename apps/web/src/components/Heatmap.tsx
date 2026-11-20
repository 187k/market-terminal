import { useEffect, useMemo, useRef, useState } from 'react';
import type { OverviewCoin } from '@mip/core/types';
import { formatSignedPct, formatUsd, formatUsdCompact } from '../format';
import { squarify } from '../treemap';

export type ChangePeriod = '1h' | '24h' | '7d';

export const changeOf = (c: OverviewCoin, period: ChangePeriod): number | null =>
  c.spot === null
    ? null
    : period === '1h'
      ? c.spot.change1hPct
      : period === '24h'
        ? c.spot.change24hPct
        : c.spot.change7dPct;

/** Changes at or beyond this many percent get the strongest colour, per period. */
const FULL_SCALE: Record<ChangePeriod, number> = { '1h': 2, '24h': 8, '7d': 20 };

function tileColour(change: number | null, period: ChangePeriod): string {
  if (change === null) return 'var(--panel-2)';
  const strength = Math.min(1, Math.abs(change) / FULL_SCALE[period]);
  // 18 % to 78 % of the tone mixed into the panel colour: even a flat coin stays readable.
  const pct = Math.round(18 + strength * 60);
  return `color-mix(in srgb, ${change >= 0 ? 'var(--pos)' : 'var(--neg)'} ${pct}%, var(--panel-2))`;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * Market map: one tile per universe coin, sized by CoinGecko market cap and coloured by the
 * price change over the chosen period. Coins without a market cap are left out (and counted).
 */
export function Heatmap({
  coins,
  period,
  onOpen,
}: {
  coins: OverviewCoin[];
  period: ChangePeriod;
  onOpen: (asset: string) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const sized = useMemo(() => coins.filter((c) => (c.spot?.marketCapUsd ?? 0) > 0), [coins]);
  const rects = useMemo(
    () =>
      squarify(
        sized.map((c) => ({ value: c.spot!.marketCapUsd!, data: c })),
        size.w,
        size.h,
      ),
    [sized, size.w, size.h],
  );
  const left = coins.length - sized.length;
  return (
    <>
      <div className="heatmap" ref={ref} role="group" aria-label={`Market map, coloured by ${period} change`}>
        {rects.map((r) => {
          const c = r.data;
          const change = changeOf(c, period);
          const big = r.w > 70 && r.h > 46;
          const small = r.w < 34 || r.h < 22;
          return (
            <button
              type="button"
              key={c.asset}
              className="heat-tile"
              style={{
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
                background: tileColour(change, period),
                fontSize: Math.max(10, Math.min(28, Math.sqrt(r.w * r.h) / 6)),
              }}
              title={`${c.name} (${c.asset}) · market cap ${formatUsdCompact(c.spot!.marketCapUsd!)} · ${period} ${change === null ? 'unknown' : formatSignedPct(change)}${c.spot?.priceUsd != null ? ` · ${formatUsd(c.spot.priceUsd)}` : ''}`}
              onClick={() => onOpen(c.asset)}
            >
              {!small && <span className="heat-sym">{c.asset}</span>}
              {!small && <span className="heat-chg">{change === null ? '—' : formatSignedPct(change)}</span>}
              {big && c.spot?.priceUsd != null && (
                <span className="heat-price">{formatUsd(c.spot.priceUsd)}</span>
              )}
            </button>
          );
        })}
        {sized.length === 0 && <div className="empty">No market caps from CoinGecko yet.</div>}
      </div>
      {left > 0 && (
        <p className="muted small heat-note">
          {left} coin{left === 1 ? '' : 's'} without a CoinGecko market cap {left === 1 ? 'is' : 'are'} not
          shown.
        </p>
      )}
    </>
  );
}
