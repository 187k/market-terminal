// Charts: TradingView Lightweight Charts™, Copyright (c) 2026 TradingView, Inc.,
// licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// The chart keeps the library's attribution logo, which links to https://www.tradingview.com/.
import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  CANDLE_INTERVALS,
  CANDLE_INTERVAL_MS,
  type Candle,
  type CandleInterval,
  type ExchangeId,
} from '@mip/core/types';
import { api, ApiError } from '../api';
import { formatFixed, formatSize } from '../format';

/** Bars shown when a chart opens; more load as the user scrolls left. */
const INITIAL_VISIBLE = 140;
/** Load the next older page when fewer than this many bars are left of the visible range. */
const LOAD_MORE_AT = 20;

/**
 * The chart library draws times as UTC. Shifting every timestamp by the browser's UTC offset
 * makes the axis read in local time. The offset is fixed for the page view: a per-bar offset
 * would create duplicate times when daylight saving ends, which the library rejects.
 */
const TZ_SHIFT_S = -new Date().getTimezoneOffset() * 60;
const toChartTime = (ms: number) => (Math.floor(ms / 1000) + TZ_SHIFT_S) as UTCTimestamp;
const fromChartTime = (t: number) => (t - TZ_SHIFT_S) * 1000;
const UTC_LABEL = (() => {
  const h = TZ_SHIFT_S / 3600;
  return `UTC${h >= 0 ? '+' : '−'}${Math.abs(h)}`;
})();

const INTERVAL_LABELS: Record<CandleInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1D',
  '1w': '1W',
};

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Hex colour with alpha, for volume bars under the candles. */
const alpha = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

interface Theme {
  pos: string;
  neg: string;
  text: string;
  muted: string;
  border: string;
  info: string;
  warn: string;
}

const candleBar = (c: Candle) => ({
  time: toChartTime(c.openTime),
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});
const volumeBar = (c: Candle, t: Theme) => ({
  time: toChartTime(c.openTime),
  value: c.volume,
  color: alpha(c.close >= c.open ? t.pos : t.neg, 0.45),
});

/** Merges `incoming` into `bars` by open time (both oldest first); incoming wins on equal times. */
function mergeBars(bars: Candle[], incoming: readonly Candle[]): Candle[] {
  const byTime = new Map(bars.map((c) => [c.openTime, c]));
  for (const c of incoming) byTime.set(c.openTime, c);
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

export interface PriceLineSpec {
  key: string;
  label: string;
  price: number | null;
}

/**
 * Candlestick chart of one instrument with volume, a crosshair legend, local-time axis and
 * infinite scroll into the past. History comes from the exchange (through the API); the newest
 * candles arrive with the terminal's live payload and are merged in place.
 */
export function CandleChart({
  exchange,
  symbol,
  interval,
  decimals,
  minMove,
  live,
  lines,
  volumeUnit,
  onInterval,
  onUnauthorized,
}: {
  exchange: ExchangeId;
  symbol: string;
  interval: CandleInterval;
  /** Price decimals, and the smallest price step (tick size, or 10^-decimals if unknown). */
  decimals: number;
  minMove: number;
  /** Newest candles from the live payload (already checked to belong to this instrument). */
  live: readonly Candle[];
  /** Horizontal reference lines such as mark and index price. */
  lines: PriceLineSpec[];
  volumeUnit: string;
  onInterval: (interval: CandleInterval) => void;
  onUnauthorized: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const theme = useRef<Theme | null>(null);
  const priceLines = useRef(new Map<string, IPriceLine>());
  const bars = useRef<Candle[]>([]);
  const pendingLive = useRef<readonly Candle[]>([]);
  // Increments on every instrument / interval change so late responses are dropped.
  const generation = useRef(0);
  const older = useRef<{ loading: boolean; exhausted: boolean }>({ loading: false, exhausted: false });
  const loadOlderRef = useRef<() => void>(() => undefined);

  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; message?: string }>({
    status: 'loading',
  });
  const [hover, setHover] = useState<Candle | null>(null);
  const [last, setLast] = useState<Candle | null>(null);
  const [visibleLines, setVisibleLines] = useState<Record<string, boolean>>({});
  const [logScale, setLogScale] = useState(false);
  const [olderNote, setOlderNote] = useState<string | null>(null);

  // Create the chart once.
  useEffect(() => {
    if (!box.current) return;
    const t: Theme = {
      pos: cssVar('--pos', '#16c784'),
      neg: cssVar('--neg', '#ea3943'),
      text: cssVar('--text', '#d1d4dc'),
      muted: cssVar('--muted', '#848e9c'),
      border: cssVar('--border', '#232a35'),
      info: cssVar('--info', '#3b82f6'),
      warn: cssVar('--warn', '#f0b90b'),
    };
    theme.current = t;
    const c = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: t.muted,
        fontSize: 11,
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
      grid: {
        vertLines: { color: alpha(t.border, 0.6) },
        horzLines: { color: alpha(t.border, 0.6) },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: { locale: 'en-US' },
    });
    const cs = c.addSeries(CandlestickSeries, {
      upColor: t.pos,
      downColor: t.neg,
      borderUpColor: t.pos,
      borderDownColor: t.neg,
      wickUpColor: t.pos,
      wickDownColor: t.neg,
    });
    const vs = c.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    c.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const onCrosshair = (p: MouseEventParams) => {
      if (p.time === undefined) return setHover(null);
      const ms = fromChartTime(p.time as number);
      setHover(bars.current.find((b) => b.openTime === ms) ?? null);
    };
    const onRange = (r: LogicalRange | null) => {
      if (r && r.from < LOAD_MORE_AT) loadOlderRef.current();
    };
    c.subscribeCrosshairMove(onCrosshair);
    c.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.current = c;
    candles.current = cs;
    volume.current = vs;
    const lineMap = priceLines.current;
    return () => {
      c.unsubscribeCrosshairMove(onCrosshair);
      c.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      lineMap.clear();
    };
  }, []);

  // Price precision follows the instrument's tick size.
  useEffect(() => {
    candles.current?.applyOptions({
      priceFormat: {
        type: 'price',
        precision: decimals,
        minMove,
      },
    });
  }, [decimals, minMove]);

  useEffect(() => {
    chart.current?.priceScale('right').applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale]);

  const setAll = (data: Candle[]) => {
    const t = theme.current;
    if (!t || !candles.current || !volume.current) return;
    bars.current = data;
    candles.current.setData(data.map(candleBar));
    volume.current.setData(data.map((c) => volumeBar(c, t)));
    setLast(data.at(-1) ?? null);
  };

  /** Applies the newest candles: updates the forming bar, appends new ones, finalises the previous. */
  const applyLive = (incoming: readonly Candle[]) => {
    const t = theme.current;
    if (!t || !candles.current || !volume.current || bars.current.length === 0) return;
    const current = bars.current;
    const firstTime = current[0]!.openTime;
    let changed = false;
    for (const c of incoming) {
      if (c.openTime < firstTime) continue;
      const lastTime = current.at(-1)!.openTime;
      const i = c.openTime > lastTime ? -1 : current.findIndex((b) => b.openTime === c.openTime);
      if (i === -1 && c.openTime < lastTime) continue; // a gap inside history: leave it to a reload
      const prev = i === -1 ? undefined : current[i];
      if (
        prev &&
        prev.open === c.open &&
        prev.high === c.high &&
        prev.low === c.low &&
        prev.close === c.close &&
        prev.volume === c.volume
      )
        continue;
      const historical = i !== -1 && i < current.length - 1;
      candles.current.update(candleBar(c), historical);
      volume.current.update(volumeBar(c, t), historical);
      if (i === -1) current.push(c);
      else current[i] = c;
      changed = true;
    }
    if (changed) setLast(current.at(-1) ?? null);
  };

  // Load history whenever the instrument or interval changes.
  useEffect(() => {
    const gen = ++generation.current;
    older.current = { loading: false, exhausted: false };
    pendingLive.current = [];
    setOlderNote(null);
    setHover(null);
    setState({ status: 'loading' });
    setAll([]);
    api.candles(exchange, symbol, interval).then(
      (res) => {
        if (gen !== generation.current) return;
        const data = mergeBars(res.candles, pendingLive.current);
        setAll(data);
        const n = data.length;
        chart.current
          ?.timeScale()
          .setVisibleLogicalRange({ from: Math.max(0, n - INITIAL_VISIBLE), to: n + 5 });
        if (n === 0) older.current.exhausted = true;
        setState({ status: 'ready' });
      },
      (err: unknown) => {
        if (gen !== generation.current) return;
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    // onUnauthorized is stable (DashboardPage), so it is not a dependency.
  }, [exchange, symbol, interval]);

  // Older pages on scroll.
  loadOlderRef.current = () => {
    const o = older.current;
    const first = bars.current[0];
    if (o.loading || o.exhausted || !first || state.status !== 'ready') return;
    o.loading = true;
    const gen = generation.current;
    api.candles(exchange, symbol, interval, first.openTime).then(
      (res) => {
        if (gen !== generation.current) return;
        o.loading = false;
        const fresh = res.candles.filter((c) => c.openTime < first.openTime);
        if (fresh.length === 0) {
          o.exhausted = true;
          setOlderNote('Start of the history the exchange provides.');
          return;
        }
        setAll(mergeBars(fresh, bars.current));
      },
      (err: unknown) => {
        if (gen !== generation.current) return;
        o.loading = false;
        o.exhausted = true; // do not retry on every scroll event; reopening the chart retries
        setOlderNote(
          `Older candles could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  // Live candles.
  useEffect(() => {
    if (state.status === 'ready') applyLive(live);
    else pendingLive.current = live;
    // applyLive only touches refs.
  }, [live, state.status]);

  // Mark / index lines.
  useEffect(() => {
    const series = candles.current;
    const t = theme.current;
    if (!series || !t) return;
    const map = priceLines.current;
    const colors: Record<string, string> = { mark: t.warn, index: t.info };
    for (const l of lines) {
      const shown = (visibleLines[l.key] ?? true) && l.price !== null;
      const existing = map.get(l.key);
      if (!shown) {
        if (existing) series.removePriceLine(existing);
        map.delete(l.key);
        continue;
      }
      const opts = {
        price: l.price!,
        color: colors[l.key] ?? t.muted,
        lineWidth: 1 as const,
        lineStyle: l.key === 'mark' ? LineStyle.Dashed : LineStyle.Dotted,
        axisLabelVisible: true,
        title: l.label,
      };
      if (existing) existing.applyOptions(opts);
      else map.set(l.key, series.createPriceLine(opts));
    }
  }, [lines, visibleLines]);

  const shown = hover ?? last;
  const intervalMs = CANDLE_INTERVAL_MS[interval];
  const p = (v: number) => formatFixed(v, decimals);

  return (
    <div className="chart-wrap">
      <div className="chart-toolbar">
        <div className="tabs" role="tablist" aria-label="Candle interval">
          {CANDLE_INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              role="tab"
              aria-selected={iv === interval}
              className={`tab ${iv === interval ? 'tab-active' : ''}`}
              onClick={() => onInterval(iv)}
            >
              {INTERVAL_LABELS[iv]}
            </button>
          ))}
        </div>
        <div className="chart-toggles">
          {lines.map((l) => (
            <label key={l.key} className={`chip ${(visibleLines[l.key] ?? true) ? 'chip-on' : ''}`}>
              <input
                type="checkbox"
                checked={visibleLines[l.key] ?? true}
                onChange={(e) => setVisibleLines({ ...visibleLines, [l.key]: e.target.checked })}
              />
              {l.label}
            </label>
          ))}
          <label className={`chip ${logScale ? 'chip-on' : ''}`} title="Logarithmic price scale">
            <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
            Log
          </label>
          <button
            type="button"
            className="btn btn-ghost small"
            onClick={() => {
              const n = bars.current.length;
              chart.current
                ?.timeScale()
                .setVisibleLogicalRange({ from: Math.max(0, n - INITIAL_VISIBLE), to: n + 5 });
              chart.current?.priceScale('right').applyOptions({ autoScale: true });
            }}
            title="Back to the newest candles"
          >
            Reset view
          </button>
        </div>
      </div>
      <div className="chart-box">
        <div className="chart-legend small" aria-live="off">
          {shown ? (
            <>
              <span className="muted">
                {new Date(shown.openTime).toLocaleString([], legendFormat(intervalMs))}
              </span>
              <span>
                <span className="muted">O</span> {p(shown.open)}
              </span>
              <span>
                <span className="muted">H</span> {p(shown.high)}
              </span>
              <span>
                <span className="muted">L</span> {p(shown.low)}
              </span>
              <span className={shown.close >= shown.open ? 'pos' : 'neg'}>
                <span className="muted">C</span> {p(shown.close)}
              </span>
              <span>
                <span className="muted">Vol</span> {formatSize(shown.volume)} {volumeUnit}
              </span>
            </>
          ) : null}
        </div>
        <div ref={box} className="chart-canvas" />
        {state.status !== 'ready' && (
          <div className={`chart-overlay ${state.status === 'error' ? 'neg' : 'muted'}`}>
            {state.status === 'loading' ? 'Loading candles…' : `Candles unavailable: ${state.message}`}
          </div>
        )}
      </div>
      <div className="chart-foot small muted">
        <span>Times in local time ({UTC_LABEL}).</span>
        {olderNote && <span>{olderNote}</span>}
      </div>
    </div>
  );
}

function legendFormat(intervalMs: number): Intl.DateTimeFormatOptions {
  if (intervalMs >= 86_400_000) return { year: 'numeric', month: 'short', day: 'numeric' };
  return { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
}
