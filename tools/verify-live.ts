// Checks the running system's data and calculations (Stage 6). Read-only: it reads Redis and
// PostgreSQL, never contacts an exchange or Telegram, and prints no secrets.
//
//   npm run verify            (needs the stack running and REDIS_URL / DATABASE_URL in .env)
//
// 1. Freshness of every exchange snapshot.
// 2. Cross-exchange agreement: each asset's price per coin (contract price ÷ multiplier) on
//    every exchange against the median of all exchanges. A wrong multiplier or a wrong mapping
//    shows up as a gap of orders of magnitude.
// 3. Field sanity: bid < ask, last near mark, funding interval and size plausible, OI > 0.
// 4. Every open and recent signal recomputed from its own stored inputs with @mip/analytics,
//    so the engine fed the right fields, in the right units, to the right formula.
// 5. History coverage: per-minute snapshots over the 4 h OI window, and funding settlements seen.
//
// Exit code 1 when a hard check fails (price gap > 5 %, signal mismatch, stale exchange that
// claims to be ok). Warnings are reported but do not fail.
import {
  connectRedis,
  createRedis,
  readExchangeHealth,
  readInstruments,
  readMarketSnapshots,
  readScannerStatus,
  readSignals,
  readUniverse,
  withReaderFreshness,
} from '@mip/bus';
import { fairPriceMetrics, funding24h, grossSpreadPct, median, oiChange, profit } from '@mip/analytics';
import {
  createLogger,
  EXCHANGE_IDS,
  loadDotEnv,
  OI_WINDOWS,
  SCANNER_IDS,
  type FairPriceData,
  type Field,
  type FundingData,
  type OpenInterestData,
  type SignalDto,
  type SpreadData,
  type TwapData,
} from '@mip/core';
import { createPrismaClient } from '@mip/db';

loadDotEnv();
const logger = createLogger({ service: 'verify', level: 'warn' });
const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!redisUrl || !databaseUrl) {
  console.error('REDIS_URL and DATABASE_URL must be set (.env)');
  process.exit(2);
}

const failures: string[] = [];
const warnings: string[] = [];
const fail = (m: string) => failures.push(m);
const warn = (m: string) => warnings.push(m);
const v = (f: Field<number> | undefined) => (f && f.available ? f.value : null);
/** Equal within a relative tolerance (absolute near zero). */
const close = (a: number | null | undefined, b: number | null | undefined, rel = 1e-6) =>
  typeof a === 'number' &&
  typeof b === 'number' &&
  Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const pct = (x: number, d = 2) => `${x.toFixed(d)} %`;
const section = (t: string) => console.log(`\n## ${t}`);

const redis = createRedis(redisUrl, logger, 'verify');
await connectRedis(redis);
const prisma = createPrismaClient(databaseUrl);
const now = Date.now();

try {
  const [snapshots, instruments, universe, health, scannerStatus] = await Promise.all([
    readMarketSnapshots(redis, EXCHANGE_IDS),
    readInstruments(redis),
    readUniverse(redis),
    readExchangeHealth(redis),
    readScannerStatus(redis),
  ]);

  // ---------------------------------------------------------------- 1. freshness
  section('1. Exchange snapshots');
  const fresh = new Map(snapshots.map((s) => [s.exchange, withReaderFreshness(s, now)]));
  for (const ex of EXCHANGE_IDS) {
    const snap = snapshots.find((s) => s.exchange === ex);
    const h = health?.exchanges.find((e) => e.exchange === ex);
    const d = h?.data;
    const line = `${ex.padEnd(12)} state=${(h?.state ?? '—').padEnd(9)} snapshot age=${snap ? `${now - snap.ts} ms` : 'none'} fresh=${d ? `${d.fresh}/${d.tracked}` : '—'} upd/s=${d?.updatesPerSec ?? '—'}`;
    console.log(line);
    if (h?.state === 'ok' && (!snap || fresh.get(ex)?.stale))
      fail(`${ex}: reported ok but its snapshot is stale`);
    if (h?.state === 'ok' && d && d.tracked > 0 && d.fresh / d.tracked < 0.9)
      warn(`${ex}: only ${d.fresh}/${d.tracked} instruments fully fresh`);
    if (h && h.state !== 'ok') warn(`${ex}: state ${h.state}${h.detail ? ` (${h.detail})` : ''}`);
  }

  // ---------------------------------------------------------------- 2. cross-exchange prices
  section('2. Price per coin across exchanges (contract price ÷ multiplier, vs median)');
  const meta = new Map<string, { multiplier: number; quote: string }>();
  for (const ex of EXCHANGE_IDS)
    for (const i of instruments?.instruments[ex] ?? []) meta.set(`${ex}:${i.symbol}`, i);
  const rowOf = new Map<string, Record<string, Field<number>>>();
  for (const [ex, s] of fresh) for (const r of s.snapshot.rows) rowOf.set(`${ex}:${r.symbol}`, r.fields);
  let assetsCompared = 0;
  let pairsCompared = 0;
  const gaps: { asset: string; ex: string; symbol: string; gap: number }[] = [];
  for (const a of universe?.assets ?? []) {
    const prices = a.instruments
      .map((i) => {
        const m = meta.get(`${i.exchange}:${i.symbol}`);
        const mark = v(rowOf.get(`${i.exchange}:${i.symbol}`)?.mark);
        return m && mark !== null ? { ...i, perCoin: mark / m.multiplier } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (prices.length < 2) continue;
    assetsCompared++;
    const mid = median(prices.map((p) => p.perCoin))!;
    for (const p of prices) {
      pairsCompared++;
      gaps.push({ asset: a.symbol, ex: p.exchange, symbol: p.symbol, gap: ((p.perCoin - mid) / mid) * 100 });
    }
  }
  gaps.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
  const over = (t: number) => gaps.filter((g) => Math.abs(g.gap) > t).length;
  console.log(
    `${assetsCompared} assets, ${pairsCompared} instruments compared. |gap| > 0.5 %: ${over(0.5)}, > 1 %: ${over(1)}, > 5 %: ${over(5)}`,
  );
  console.log(
    `largest: ${gaps
      .slice(0, 5)
      .map((g) => `${g.asset} ${g.ex} ${g.symbol} ${pct(g.gap, 3)}`)
      .join('; ')}`,
  );
  for (const g of gaps.filter((x) => Math.abs(x.gap) > 5))
    fail(`price gap ${pct(g.gap)}: ${g.asset} on ${g.ex} (${g.symbol}); multiplier or mapping problem?`);
  for (const g of gaps.filter((x) => Math.abs(x.gap) > 1 && Math.abs(x.gap) <= 5))
    warn(`price gap ${pct(g.gap)}: ${g.asset} on ${g.ex} (${g.symbol})`);

  // ---------------------------------------------------------------- 3. field sanity
  section('3. Field sanity (fresh values only)');
  for (const [ex, s] of fresh) {
    const problems: Record<string, string[]> = {};
    const add = (k: string, sym: string) => (problems[k] ??= []).push(sym);
    for (const r of s.snapshot.rows) {
      const f = r.fields;
      const bid = v(f.bid);
      const ask = v(f.ask);
      const last = v(f.last);
      const mark = v(f.mark);
      const rate = v(f.fundingRate);
      const interval = v(f.fundingIntervalHours);
      const oi = v(f.openInterest);
      const next = v(f.nextFundingTime);
      if (bid !== null && ask !== null && bid >= ask) add('bid >= ask', r.symbol);
      if (last !== null && mark !== null && Math.abs(last / mark - 1) > 0.02)
        add('last vs mark > 2 %', r.symbol);
      if (interval !== null && ![1, 2, 4, 8].includes(interval))
        add(`funding interval ${interval} h`, r.symbol);
      if (rate !== null && Math.abs(rate) > 0.03) add('|funding| > 3 % per interval', r.symbol);
      if (oi !== null && oi <= 0) add('open interest <= 0', r.symbol);
      if (next !== null && (next < now - 120_000 || next > now + 9 * 3_600_000))
        add('next funding outside now…+9 h', r.symbol);
    }
    const keys = Object.keys(problems);
    console.log(
      `${ex.padEnd(12)} ${s.snapshot.rows.length} rows: ${keys.length ? keys.map((k) => `${k} ×${problems[k]!.length} (${problems[k]!.slice(0, 3).join(', ')})`).join('; ') : 'no problems'}`,
    );
    for (const k of keys) {
      const msg = `${ex}: ${k} on ${problems[k]!.length} instrument(s), e.g. ${problems[k]!.slice(0, 3).join(', ')}`;
      if (k === 'bid >= ask') fail(msg);
      else warn(msg);
    }
  }

  // ---------------------------------------------------------------- 4. signals recomputed
  section('4. Signals recomputed from their stored inputs');
  const signals: SignalDto[] = [];
  for (const id of SCANNER_IDS) {
    const st = await readSignals(redis, id);
    signals.push(...(st?.active ?? []), ...(st?.recent ?? []));
  }
  const checked: Record<string, { n: number; bad: number }> = {};
  const check = (s: SignalDto, ok: boolean, what: string) => {
    const c = (checked[s.scanner] ??= { n: 0, bad: 0 });
    c.n++;
    if (!ok) {
      c.bad++;
      fail(`${s.scanner} ${s.asset} (${s.key}): ${what}`);
    }
  };
  for (const s of signals) {
    if (s.scanner === 'fair-price') {
      const d = s.data as Partial<FairPriceData>;
      if (typeof d.last !== 'number' || typeof d.mark !== 'number') continue;
      const m = fairPriceMetrics({
        last: d.last,
        mark: d.mark,
        index: d.index ?? null,
        bid: d.bid ?? null,
        ask: d.ask ?? null,
        bidSize: null,
        askSize: null,
      });
      check(
        s,
        close(m?.deviationPct, d.deviationPct) && close(m?.deviationPct, s.value),
        'deviation ≠ (last − mark) / mark × 100',
      );
      check(
        s,
        (d.executableEdgePct ?? null) === null || close(m?.executableEdgePct, d.executableEdgePct),
        'executable edge',
      );
      check(
        s,
        (d.fairVsIndexPct ?? null) === null || close(m?.fairVsIndexPct, d.fairVsIndexPct),
        'fair vs index',
      );
      check(s, (s.direction === 'LONG') === d.deviationPct! < 0, 'direction does not match the sign');
    } else if (s.scanner === 'funding') {
      const d = s.data as Partial<FundingData>;
      for (const l of d.legs ?? [])
        check(
          s,
          close(funding24h(l.rate, l.intervalHours), l.rate24h),
          `${l.exchange} rate24h ≠ rate × 24 / interval`,
        );
      if (d.kind === 'extreme' && d.leg)
        check(s, close(d.leg.rate24h * 100, s.value), 'value ≠ leg 24 h funding');
      if (d.kind === 'arbitrage' && d.long && d.short) {
        check(s, close(d.short.rate24h - d.long.rate24h, d.difference24h), 'difference ≠ short − long');
        check(s, d.short.rate24h >= d.long.rate24h, 'short leg must have the higher funding');
        check(s, close((d.difference24h ?? NaN) * 100, s.value), 'value ≠ difference');
      }
    } else if (s.scanner === 'open-interest') {
      const d = s.data as Partial<OpenInterestData>;
      if (typeof d.openInterest !== 'number' || typeof d.price !== 'number' || !d.windows) continue;
      for (const w of OI_WINDOWS) {
        const r = d.windows[w];
        if (!r?.available) continue;
        const c = oiChange(d.openInterest, r.previous, d.price);
        check(
          s,
          close(c?.changePct, r.changePct) &&
            close(c?.changeBase, r.changeBase) &&
            close(c?.changeUsd, r.changeUsd),
          `${w} window ≠ oiChange(current, previous, mark)`,
        );
      }
      const p = d.primaryWindow ? d.windows[d.primaryWindow] : undefined;
      if (p?.available) check(s, close(p.changePct, s.value), 'value ≠ primary window change');
    } else if (s.scanner === 'spread') {
      const d = s.data as Partial<SpreadData>;
      if (!d.buy || !d.sell || !d.breakdown || !d.execution) continue;
      check(
        s,
        close(grossSpreadPct(d.buy.ask, d.sell.bid), d.grossPct),
        'gross ≠ (sell bid − buy ask) / buy ask',
      );
      check(
        s,
        close(d.buy.rawAsk / d.buy.multiplier, d.buy.ask) &&
          close(d.sell.rawBid / d.sell.multiplier, d.sell.bid),
        'per-coin price ≠ contract price ÷ multiplier',
      );
      const b = profit({
        qty: d.qty!,
        buyPrice: d.execution.buyVwap ?? d.buy.ask,
        sellPrice: d.execution.sellVwap ?? d.sell.bid,
        buyFeeRate: d.buyFeeRate!,
        sellFeeRate: d.sellFeeRate!,
        fundingCost: d.breakdown.fundingCost,
      });
      check(
        s,
        close(b.netProfit, d.breakdown.netProfit) &&
          close(b.fees, d.breakdown.fees) &&
          close(b.netPct, d.netPct),
        'profit breakdown ≠ profit()',
      );
      if ((d.holdingHours ?? 0) > 0 && d.buy.funding24h !== null && d.sell.funding24h !== null)
        check(
          s,
          close(
            d.positionUsd! * (d.buy.funding24h - d.sell.funding24h) * (d.holdingHours! / 24),
            d.breakdown.fundingCost,
          ),
          'funding cost over the holding period',
        );
      check(s, close(d.netPct, s.value), 'value ≠ net %');
    } else if (s.scanner === 'twap') {
      const d = s.data as Partial<TwapData>;
      if (d.kind !== 'heuristic' || !d.executedQty) continue;
      check(s, close(d.vwap! * d.executedQty, d.executedNotional, 1e-6), 'VWAP × quantity ≠ executed volume');
      check(s, close(d.executedNotional, s.value), 'value ≠ executed volume');
    }
  }
  for (const id of SCANNER_IDS) {
    const c = checked[id];
    console.log(`${id.padEnd(14)} ${c ? `${c.n} checks, ${c.bad} mismatches` : 'no signals to check'}`);
  }

  // ---------------------------------------------------------------- 5. history coverage
  section('5. History behind the OI windows and funding settlements');
  const since = new Date(now - 4 * 3_600_000 - 5 * 60_000);
  const minutes = await prisma.marketSnapshot.groupBy({
    by: ['exchange'],
    where: { ts: { gte: since } },
    _min: { ts: true },
    _count: { _all: true },
  });
  const distinct = await prisma.$queryRaw<{ exchange: string; minutes: bigint }[]>`
    select exchange, count(distinct ts) as minutes from market_snapshots where ts >= ${since} group by exchange`;
  for (const ex of EXCHANGE_IDS) {
    const m = minutes.find((x) => x.exchange === ex);
    const d = distinct.find((x) => x.exchange === ex);
    const covered = Number(d?.minutes ?? 0);
    console.log(
      `${ex.padEnd(12)} minutes stored in the last 4 h 05 m: ${covered} / 245${m?._min.ts ? `, oldest ${m._min.ts.toISOString()}` : ''}`,
    );
    if (covered > 0 && covered < 230) warn(`${ex}: only ${covered} of 245 minutes stored for the 4 h window`);
  }
  const oiWarn = scannerStatus?.scanners.find((s) => s.id === 'open-interest')?.warnings ?? [];
  console.log(`OI scanner warnings: ${oiWarn.length ? oiWarn.join('; ') : 'none (all windows covered)'}`);
  const legs = signals
    .filter((s) => s.scanner === 'funding')
    .flatMap((s) => (s.data as Partial<FundingData>).legs ?? []);
  const settled = legs.filter((l) => l.lastSettled);
  console.log(`funding legs in signals: ${legs.length}, with an observed settlement: ${settled.length}`);
  if (settled[0])
    console.log(
      `  e.g. ${settled[0].exchange} ${settled[0].symbol}: settled ${new Date(settled[0].lastSettled!.at).toISOString()} at ${(settled[0].lastSettled!.rate * 100).toFixed(4)} %`,
    );

  // ---------------------------------------------------------------- result
  section('Result');
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const f of failures) console.log(`FAIL: ${f}`);
  console.log(failures.length ? `${failures.length} failure(s)` : 'all hard checks passed');
  process.exitCode = failures.length ? 1 : 0;
} finally {
  redis.disconnect();
  await prisma.$disconnect();
}
