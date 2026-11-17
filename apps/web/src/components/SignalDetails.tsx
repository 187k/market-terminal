import type { ReactNode } from 'react';
import {
  OI_WINDOWS,
  type FairPriceData,
  type FundingData,
  type FundingLegData,
  type OpenInterestData,
  type SignalDto,
  type SpreadData,
  type SpreadLeg,
  type TwapData,
} from '@mip/core/types';
import {
  formatCompact,
  formatCountdown,
  formatDuration,
  formatPrice,
  formatRate,
  formatSignedPct,
  formatWhen,
} from '../format';
import { useNow } from '../hooks';
import { directionTone, exName, headline, signTone } from '../signalView';

const dash = '—';
const n = (v: number | null | undefined, f: (x: number) => string): string =>
  typeof v === 'number' && Number.isFinite(v) ? f(v) : dash;
const usd = (v: number | null | undefined) => n(v, (x) => `$${formatCompact(x)}`);
const pct = (v: number | null | undefined, d = 2) => (
  <span className={signTone(v)}>{n(v, (x) => formatSignedPct(x, d))}</span>
);

function Facts({ items }: { items: [string, ReactNode, string?][] }) {
  return (
    <dl className="facts">
      {items.map(([k, v, title]) => (
        <div key={k} title={title}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Notes({ title, items, tone }: { title: string; items: string[] | undefined; tone?: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="notes">
      <h3 className="small muted">{title}</h3>
      <ul className={tone}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Link({ url, children }: { url: string | null | undefined; children: ReactNode }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function FairPrice({ d }: { d: Partial<FairPriceData> }) {
  const now = useNow();
  const ref = d.indexKind === 'oracle' ? 'Oracle' : 'Index';
  return (
    <>
      <Facts
        items={[
          ['Instrument', <Link url={d.url}>{`${exName(d.exchange)} ${d.symbol ?? ''}`}</Link>],
          ['Last', n(d.last, formatPrice)],
          ['Mark (fair)', n(d.mark, formatPrice)],
          [
            ref,
            n(d.index, formatPrice),
            d.indexKind === 'oracle' ? 'Hyperliquid publishes an oracle price, not an index' : undefined,
          ],
          ['Bid / ask', `${n(d.bid, formatPrice)} / ${n(d.ask, formatPrice)}`],
          ['Deviation', pct(d.deviationPct), '(last − mark) / mark × 100'],
          ['Executable edge', pct(d.executableEdgePct), 'How far the book still offers the deviation'],
          [
            `Fair vs ${ref.toLowerCase()}`,
            <>
              {pct(d.fairVsIndexPct)}
              {d.fairIndexWarning ? <span className="warn"> ⚠</span> : null}
            </>,
          ],
          ['Book spread', n(d.spreadPct, (x) => `${x.toFixed(3)} %`)],
          ['Top of book', usd(d.topOfBookUsd)],
          ['24h turnover', usd(d.turnover24h)],
          [
            'Funding',
            <>
              {n(d.fundingRate, formatRate)}
              {d.fundingIntervalHours ? <span className="muted"> / {d.fundingIntervalHours}h</span> : null}
            </>,
          ],
          ['Next funding', d.nextFundingTime ? formatCountdown(d.nextFundingTime, now) : dash],
          ['Max leverage', d.maxLeverage ? `${d.maxLeverage}×` : (d.maxLeverageNote ?? dash)],
          ['Quote', d.quote ?? dash],
          [
            'Risk',
            <span className={d.risk?.level === 'high' ? 'neg' : d.risk?.level === 'medium' ? 'warn' : ''}>
              {d.risk?.level ?? dash}
            </span>,
          ],
        ]}
      />
      <Notes title="Risk factors" items={d.risk?.reasons} />
    </>
  );
}

function OpenInterest({ d }: { d: Partial<OpenInterestData> }) {
  return (
    <>
      <Facts
        items={[
          ['Instrument', <Link url={d.url}>{`${exName(d.exchange)} ${d.symbol ?? ''}`}</Link>],
          ['Open interest', n(d.openInterest, formatCompact), 'One side, base units'],
          ['Open interest, $', usd(d.openInterestUsd)],
          ['Price', n(d.price, formatPrice)],
          [
            'Funding',
            <>
              {n(d.fundingRate, formatRate)}
              {d.fundingIntervalHours ? <span className="muted"> / {d.fundingIntervalHours}h</span> : null}
            </>,
          ],
          ['24h turnover', usd(d.turnover24h)],
          [
            'Long/short ratio',
            'not collected',
            'Available from REST on some exchanges only; not collected in this version',
          ],
        ]}
      />
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Window</th>
              <th className="num">OI change</th>
              <th className="num">Change, base</th>
              <th className="num">Change, $</th>
              <th className="num">Price change</th>
              <th>Scenario</th>
            </tr>
          </thead>
          <tbody>
            {OI_WINDOWS.map((w) => {
              const r = d.windows?.[w];
              const primary = d.primaryWindow === w;
              if (!r || !r.available)
                return (
                  <tr key={w}>
                    <td>{w}</td>
                    <td colSpan={5} className="muted">
                      {r?.reason === 'warming_up' ? 'history still warming up' : 'no snapshot near that time'}
                    </td>
                  </tr>
                );
              return (
                <tr key={w} className={primary ? 'row-open' : undefined}>
                  <td>
                    {w}
                    {primary ? ' ★' : ''}
                  </td>
                  <td className="num">{pct(r.changePct, 1)}</td>
                  <td className="num">{formatCompact(r.changeBase)}</td>
                  <td className="num">{usd(r.changeUsd)}</td>
                  <td className="num">{pct(r.priceChangePct)}</td>
                  <td>
                    {r.scenario ? (
                      <>
                        {r.scenario}: price {(r.priceChangePct ?? 0) > 0 ? '↑' : '↓'} OI{' '}
                        {r.changePct > 0 ? '↑' : '↓'}
                      </>
                    ) : (
                      dash
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {d.oiNote && <p className="small muted">{d.oiNote}</p>}
    </>
  );
}

function FundingLegs({ legs, now }: { legs: FundingLegData[]; now: number }) {
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Exchange</th>
            <th className="num">Rate</th>
            <th className="num">Interval</th>
            <th className="num">24h</th>
            <th className="num">Next</th>
            <th className="num" title="Last live rate seen before the most recent settlement">
              Last settled
            </th>
            <th className="num">24h turnover</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={`${l.exchange}:${l.symbol}`}>
              <td>
                <Link url={l.url}>{`${exName(l.exchange)} ${l.symbol}`}</Link>
                {l.quote !== 'USDT' ? <span className="muted"> ({l.quote})</span> : null}
              </td>
              <td className={`num ${signTone(l.rate)}`}>{formatRate(l.rate)}</td>
              <td className="num">{l.intervalHours}h</td>
              <td className={`num ${signTone(l.rate24h)}`}>{(l.rate24h * 100).toFixed(3)} %</td>
              <td className="num">{l.nextFundingTime ? formatCountdown(l.nextFundingTime, now) : dash}</td>
              <td className="num">
                {l.lastSettled ? (
                  <span title={`settled ${formatWhen(l.lastSettled.at)}`}>
                    {formatRate(l.lastSettled.rate)}
                  </span>
                ) : (
                  dash
                )}
              </td>
              <td className="num">{usd(l.turnover24h)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Funding({ d }: { d: Partial<FundingData> }) {
  const now = useNow();
  return (
    <>
      <Facts
        items={
          d.kind === 'arbitrage'
            ? [
                ['Type', 'Funding difference between exchanges'],
                ['Long (lowest funding)', exName(d.long?.exchange)],
                ['Short (highest funding)', exName(d.short?.exchange)],
                ['Difference, 24h', n(d.difference24h, (x) => `${(x * 100).toFixed(3)} %`)],
              ]
            : [
                ['Type', 'Extreme funding'],
                ['Exchange', exName(d.leg?.exchange)],
                ['Rate', n(d.leg?.rate, formatRate)],
                ['Normalised to 24h', n(d.leg?.rate24h, (x) => `${(x * 100).toFixed(3)} %`)],
              ]
        }
      />
      {d.mixedQuotes && (
        <p className="small warn">
          Mixed quotes: USDC (Hyperliquid) compared with USDT; the USDT/USDC basis is ignored.
        </p>
      )}
      <h3 className="small muted">Funding on every exchange with fresh data</h3>
      <FundingLegs legs={d.legs ?? []} now={now} />
    </>
  );
}

function SpreadLegCell({ leg, side }: { leg: SpreadLeg | undefined; side: 'buy' | 'sell' }) {
  if (!leg) return <>{dash}</>;
  return (
    <>
      <Link url={leg.url}>{`${exName(leg.exchange)} ${leg.symbol}`}</Link>{' '}
      <span className="muted">
        {side === 'buy' ? `ask ${formatPrice(leg.ask)}` : `bid ${formatPrice(leg.bid)}`}
        {leg.multiplier !== 1 ? ` (×${leg.multiplier})` : ''} · {leg.quote}
      </span>
    </>
  );
}

function Spread({ d }: { d: Partial<SpreadData> }) {
  const b = d.breakdown;
  const e = d.execution;
  return (
    <>
      <Facts
        items={[
          ['Buy at', <SpreadLegCell leg={d.buy} side="buy" />],
          ['Sell at', <SpreadLegCell leg={d.sell} side="sell" />],
          ['Gross spread', n(d.grossPct, (x) => `${x.toFixed(3)} %`)],
          ['Net spread', pct(d.netPct, 3)],
          ['Position', usd(d.positionUsd), 'Per leg, used for VWAP and profit'],
          ['Quantity', n(d.qty, formatCompact), 'Asset units'],
          [
            'Taker fees',
            `${n(d.buyFeeRate, (x) => `${(x * 100).toFixed(3)} %`)} / ${n(d.sellFeeRate, (x) => `${(x * 100).toFixed(3)} %`)}`,
          ],
          ['Holding period', n(d.holdingHours, (x) => `${x} h`)],
        ]}
      />
      <h3 className="small muted">Profit breakdown</h3>
      <Facts
        items={[
          ['Purchase cost', n(b?.purchaseCost, (x) => `$${x.toFixed(2)}`)],
          ['Sale proceeds', n(b?.saleProceeds, (x) => `$${x.toFixed(2)}`)],
          [
            'Gross profit',
            <span className={signTone(b?.grossProfit)}>{n(b?.grossProfit, (x) => `$${x.toFixed(2)}`)}</span>,
          ],
          ['Fees', n(b?.fees, (x) => `−$${x.toFixed(2)}`)],
          [
            'Funding',
            n(b?.fundingCost, (x) =>
              Math.abs(x) < 0.005 ? '$0.00' : x > 0 ? `−$${x.toFixed(2)}` : `+$${(-x).toFixed(2)}`,
            ),
            'Paid (−) or received (+) over the holding period',
          ],
          [
            'Net profit',
            <span className={signTone(b?.netProfit)}>{n(b?.netProfit, (x) => `$${x.toFixed(2)}`)}</span>,
          ],
        ]}
      />
      <h3 className="small muted">Execution (order-book VWAP)</h3>
      <Facts
        items={[
          [
            'Buy VWAP',
            <>
              {n(e?.buyVwap, formatPrice)}
              {/* "Too thin" only when a book was fetched; a missing book is explained below. */}
              {e && !e.error && !e.buyComplete ? <span className="warn"> (book too thin)</span> : null}
            </>,
          ],
          [
            'Sell VWAP',
            <>
              {n(e?.sellVwap, formatPrice)}
              {e && !e.error && !e.sellComplete ? <span className="warn"> (book too thin)</span> : null}
            </>,
          ],
          ['Buy slippage', n(e?.buySlippagePct, (x) => `${x.toFixed(3)} %`)],
          ['Sell slippage', n(e?.sellSlippagePct, (x) => `${x.toFixed(3)} %`)],
        ]}
      />
      {e?.error && <p className="small warn">Order book: {e.error}</p>}
      <Notes title="Preliminary because" items={d.preliminary} tone="warn" />
      <Notes title="Compatibility" items={d.compatibility} />
      <Notes title={`Risk: ${d.risk?.level ?? dash}`} items={d.risk?.reasons} />
      {d.legs && d.legs.length > 0 && (
        <>
          <h3 className="small muted">All exchanges (prices per asset unit)</h3>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Exchange</th>
                  <th className="num">Bid</th>
                  <th className="num">Ask</th>
                  <th className="num">vs average</th>
                  <th className="num">Funding</th>
                  <th className="num">24h turnover</th>
                </tr>
              </thead>
              <tbody>
                {d.legs.map((l) => (
                  <tr key={`${l.exchange}:${l.symbol}`}>
                    <td>
                      <Link url={l.url}>{`${exName(l.exchange)} ${l.symbol}`}</Link>
                    </td>
                    <td className="num">{formatPrice(l.bid)}</td>
                    <td className="num">{formatPrice(l.ask)}</td>
                    <td className="num">
                      {pct(d.deviations?.find((x) => x.exchange === l.exchange)?.pct, 3)}
                    </td>
                    <td className="num">
                      {n(l.fundingRate, formatRate)}
                      {l.fundingIntervalHours ? (
                        <span className="muted"> / {l.fundingIntervalHours}h</span>
                      ) : null}
                    </td>
                    <td className="num">{usd(l.turnover24h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Twap({ d }: { d: Partial<TwapData> }) {
  const confirmed = d.kind === 'confirmed';
  return (
    <>
      <p className={`small ${confirmed ? 'info' : 'muted'}`}>
        {confirmed
          ? 'Exchange-confirmed TWAP (Hyperliquid reports the order and its slices).'
          : `Heuristic: a pattern of similar trades, confidence ${n(d.confidence, (x) => `${Math.round(x * 100)} %`)}. It may not be one order.`}
        {d.label ? ` ${d.label}.` : ''}
      </p>
      <Facts
        items={[
          ['Instrument', <Link url={d.url}>{`${exName(d.exchange)} ${d.symbol ?? ''}`}</Link>],
          [
            'Side',
            <span className={directionTone(d.side ?? null)}>{d.side ?? dash}</span>,
            'Analytical direction, not a recommendation',
          ],
          ['Status', d.status ?? dash],
          ['Slices', n(d.slices, String)],
          ['First / last', `${formatWhen(d.firstTs ?? null)} / ${formatWhen(d.lastTs ?? null)}`],
          [
            'Duration',
            typeof d.firstTs === 'number' && typeof d.lastTs === 'number'
              ? formatDuration(d.lastTs - d.firstTs)
              : dash,
          ],
          [
            'Executed',
            <>
              {usd(d.executedNotional)}{' '}
              <span className="muted">
                ({d.executedSource === 'exchange' ? 'exchange figure' : 'observed slices'})
              </span>
            </>,
          ],
          ['Executed qty', n(d.executedQty, formatCompact)],
          ['VWAP', n(d.vwap, formatPrice)],
          [
            'Price now',
            <>
              {n(d.priceNow, formatPrice)} {pct(d.priceChangePct)}
            </>,
          ],
          [
            confirmed ? 'Order size' : 'Executed so far',
            usd(d.orderNotional),
            confirmed ? 'Total size × price' : 'A lower bound: the pattern may continue',
          ],
          [
            'Executed share',
            n(d.executedPct, (x) => `${x.toFixed(0)} %`),
            'Known only once the order finished or was stopped',
          ],
          [
            'Time elapsed',
            n(d.elapsedPct, (x) => `${x.toFixed(0)} %`),
            'Share of the scheduled duration (time-based, not fills)',
          ],
          ['Wallet', d.wallet ? <span className="mono">{d.wallet}</span> : dash],
          ['Wallet TWAP history', n(d.walletTwapCount, String)],
          [
            'TWAP settings',
            d.twap
              ? `${d.twap.minutes} min${d.twap.randomize ? ', randomized' : ''}${d.twap.reduceOnly ? ', reduce-only' : ''}`
              : dash,
          ],
          ['Market cap', usd(d.marketCapUsd)],
          ['24h turnover', usd(d.turnover24h)],
        ]}
      />
      {!confirmed && d.metrics && (
        <Facts
          items={[
            [
              'Interval regularity (CV)',
              n(d.metrics.cvInterval, (x) => x.toFixed(2)),
              'Lower = more regular timing',
            ],
            ['Size regularity (CV)', n(d.metrics.cvSize, (x) => x.toFixed(2)), 'Lower = more similar sizes'],
            ['Median interval', n(d.metrics.medianIntervalMs, formatDuration)],
            ['One-sidedness', n(d.metrics.oneSided, (x) => `${Math.round(x * 100)} %`)],
          ]}
        />
      )}
      {d.note && <p className="small muted">{d.note}</p>}
    </>
  );
}

/** Everything stored with one signal, laid out per scanner. */
export function SignalDetails({ signal }: { signal: SignalDto }) {
  const d = signal.data;
  return (
    <div className="signal-details">
      <p className="signal-head">
        <b className={directionTone(signal.direction)}>{headline(signal)}</b> {signal.title}
      </p>
      <Facts
        items={[
          ['Status', signal.status],
          ['Opened', formatWhen(signal.firstSeenAt)],
          ['Last seen', formatWhen(signal.lastSeenAt)],
          ['Resolved', formatWhen(signal.resolvedAt)],
          ['Peak', String(Math.round(signal.peakValue * 1000) / 1000)],
          ['Significant updates', String(signal.updates)],
          [
            'Telegram',
            `${signal.telegram.state}${signal.telegram.detail ? ` (${signal.telegram.detail})` : ''}`,
          ],
        ]}
      />
      {signal.scanner === 'fair-price' && <FairPrice d={d as Partial<FairPriceData>} />}
      {signal.scanner === 'open-interest' && <OpenInterest d={d as Partial<OpenInterestData>} />}
      {signal.scanner === 'funding' && <Funding d={d as Partial<FundingData>} />}
      {signal.scanner === 'spread' && <Spread d={d as Partial<SpreadData>} />}
      {signal.scanner === 'twap' && <Twap d={d as Partial<TwapData>} />}
      <p className="small muted disclaimer">Analytical signal, not a trading recommendation.</p>
    </div>
  );
}
