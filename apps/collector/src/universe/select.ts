import {
  EXCHANGE_IDS,
  type ExchangeId,
  type InstrumentInfo,
  type MappingProblem,
  type UniverseAsset,
  type UniverseInfo,
} from '@mip/core';
import type { CoinMarket } from '@mip/connectors';

/** Latest price (quote currency per base unit) and 24 h turnover of one instrument. */
export interface Quote {
  price: number;
  turnover: number | null;
}

export const quoteKey = (exchange: ExchangeId, symbol: string) => `${exchange}:${symbol}`;

/**
 * Hand-maintained mapping data. CoinGecko symbols are not unique and exchanges sometimes keep
 * an old ticker after a rebrand, so assets are tied by CoinGecko id, never by ticker text alone.
 */
export const OVERRIDES = {
  /** CoinGecko id -> extra exchange asset codes that represent it. */
  aliases: {} as Record<string, string[]>,
  /** CoinGecko ids never included (in addition to the excluded categories). */
  excludedIds: [] as string[],
  /** Asset codes never included when ranking by volume (no CoinGecko categories available). */
  volumeExcludedAssets: [
    'USDT',
    'USDC',
    'USDE',
    'FDUSD',
    'DAI',
    'TUSD',
    'USD1',
    'PYUSD',
    'RLUSD',
    'USDS',
    'USDD',
    'FRAX',
    'BUSD',
    'XAUT',
    'PAXG',
    'WBTC',
    'WETH',
    'STETH',
    'WSTETH',
    'WEETH',
    'CBBTC',
  ],
};

export interface SelectOptions {
  size: number;
  instruments: InstrumentInfo[];
  quotes: Map<string, Quote>;
  /** Largest relative difference between an instrument's asset price and the reference price. */
  maxDeviation: number;
  /** Age of the CoinGecko prices; older data gets a wider tolerance (prices move). */
  referenceAgeMs?: number;
  now?: number;
}

/** CoinGecko prices older than this are only trusted to catch gross mismatches. */
export const FRESH_REFERENCE_MS = 60 * 60_000;
const STALE_REFERENCE_DEVIATION = 0.5;

interface Candidate {
  instrument: InstrumentInfo;
  quote: Quote;
  assetPrice: number;
}

function byAsset(instruments: InstrumentInfo[]): Map<string, InstrumentInfo[]> {
  const map = new Map<string, InstrumentInfo[]>();
  for (const i of instruments) {
    const code = i.asset.toUpperCase();
    map.set(code, [...(map.get(code) ?? []), i]);
  }
  return map;
}

/** One instrument per exchange: the most traded one if an exchange lists the asset twice. */
function onePerExchange(list: Candidate[]): Candidate[] {
  const best = new Map<ExchangeId, Candidate>();
  for (const c of list) {
    const cur = best.get(c.instrument.exchange);
    if (!cur || (c.quote.turnover ?? 0) > (cur.quote.turnover ?? 0)) best.set(c.instrument.exchange, c);
  }
  return [...best.values()].sort(
    (a, b) => EXCHANGE_IDS.indexOf(a.instrument.exchange) - EXCHANGE_IDS.indexOf(b.instrument.exchange),
  );
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

/**
 * Picks the N largest crypto assets by CoinGecko market cap that have at least one USDT
 * perpetual whose price matches (after the multiplier). Two checks, both must pass:
 *
 * 1. each instrument is within `maxDeviation` of the median across exchanges (catches one
 *    exchange listing a different asset under the same ticker, or a wrong multiplier);
 * 2. that median is within `maxDeviation` of CoinGecko's price, or within 50 % when the
 *    CoinGecko data is older than an hour (prices move; this still catches collisions, which
 *    are usually orders of magnitude apart).
 *
 * Failing instruments are reported, never included. USDT and USDC are taken as 1 USD here.
 */
export function selectByMarketCap(
  coins: CoinMarket[],
  excludedIds: ReadonlySet<string>,
  opts: SelectOptions,
): UniverseInfo {
  const index = byAsset(opts.instruments);
  const claimed = new Set<string>();
  const assets: UniverseAsset[] = [];
  const problems: MappingProblem[] = [];
  const excluded = new Set([...excludedIds, ...OVERRIDES.excludedIds]);
  const stale = (opts.referenceAgeMs ?? 0) > FRESH_REFERENCE_MS;
  const referenceTolerance = stale
    ? Math.max(STALE_REFERENCE_DEVIATION, opts.maxDeviation)
    : opts.maxDeviation;

  for (const coin of coins) {
    if (assets.length >= opts.size) break;
    if (excluded.has(coin.id) || !coin.current_price || !coin.market_cap) continue;
    const codes = [coin.symbol.toUpperCase(), ...(OVERRIDES.aliases[coin.id] ?? [])];
    const found = codes
      .flatMap((c) => index.get(c) ?? [])
      .filter((i) => !claimed.has(quoteKey(i.exchange, i.symbol)));
    const priced: Candidate[] = [];
    for (const instrument of found) {
      const quote = opts.quotes.get(quoteKey(instrument.exchange, instrument.symbol));
      if (!quote) {
        problems.push({
          exchange: instrument.exchange,
          symbol: instrument.symbol,
          assetId: coin.id,
          reason: 'no price to verify the mapping',
        });
        continue;
      }
      priced.push({ instrument, quote, assetPrice: quote.price / instrument.multiplier });
    }
    if (priced.length === 0) continue;
    const reference = coin.current_price;

    // Consensus among exchanges whose price is near CoinGecko's (so a majority of colliding
    // tickers cannot pull the median onto the wrong asset), then each instrument against it.
    const near = priced.filter((c) => Math.abs(c.assetPrice / reference - 1) <= referenceTolerance);
    const consensus = near.length > 0 ? median(near.map((c) => c.assetPrice)) : null;
    const accepted: Candidate[] = [];
    for (const c of priced) {
      const vsCoinGecko = Math.abs(c.assetPrice / reference - 1);
      const vsConsensus = consensus === null ? Infinity : Math.abs(c.assetPrice / consensus - 1);
      if (vsCoinGecko <= referenceTolerance && vsConsensus <= opts.maxDeviation) {
        accepted.push(c);
        continue;
      }
      problems.push({
        exchange: c.instrument.exchange,
        symbol: c.instrument.symbol,
        assetId: coin.id,
        reason:
          vsCoinGecko > referenceTolerance
            ? `price ${c.assetPrice.toPrecision(6)} vs CoinGecko ${coin.current_price} (${pct(vsCoinGecko)} apart): different asset or wrong multiplier`
            : `price ${c.assetPrice.toPrecision(6)} is ${pct(vsConsensus)} from the other exchanges (${consensus!.toPrecision(6)})`,
      });
    }
    if (accepted.length === 0) continue;
    const chosen = onePerExchange(accepted);
    for (const c of chosen) claimed.add(quoteKey(c.instrument.exchange, c.instrument.symbol));
    assets.push({
      id: coin.id,
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      rank: assets.length + 1,
      marketCapRank: coin.market_cap_rank,
      marketCapUsd: coin.market_cap,
      priceUsd: coin.current_price,
      instruments: chosen.map((c) => ({ exchange: c.instrument.exchange, symbol: c.instrument.symbol })),
    });
  }

  const warnings: string[] = [];
  if (assets.length < opts.size)
    warnings.push(`only ${assets.length} of ${opts.size} assets could be matched to perpetuals`);
  if (stale)
    warnings.push(
      `CoinGecko prices are ${Math.round((opts.referenceAgeMs ?? 0) / 3_600_000)} h old: mappings were checked against the cross-exchange median, with CoinGecko only as a ±${pct(referenceTolerance)} sanity bound`,
    );
  return {
    source: 'coingecko',
    builtAt: opts.now ?? Date.now(),
    size: opts.size,
    assets,
    problems,
    warnings,
  };
}

/**
 * Fallback when CoinGecko is unavailable and nothing is cached: rank assets by their summed
 * 24 h perpetual turnover. Instruments whose asset price is far from the cross-exchange median
 * are rejected as probable ticker collisions. Market cap is unavailable in this mode.
 */
export function selectByVolume(opts: SelectOptions): UniverseInfo {
  const excludedAssets = new Set(OVERRIDES.volumeExcludedAssets);
  const problems: MappingProblem[] = [];
  const ranked: { code: string; turnover: number; reference: number; chosen: Candidate[] }[] = [];

  for (const [code, instruments] of byAsset(opts.instruments)) {
    if (excludedAssets.has(code)) continue;
    const candidates: Candidate[] = [];
    for (const instrument of instruments) {
      const quote = opts.quotes.get(quoteKey(instrument.exchange, instrument.symbol));
      if (quote) candidates.push({ instrument, quote, assetPrice: quote.price / instrument.multiplier });
    }
    if (candidates.length === 0) continue;
    const reference = median(candidates.map((c) => c.assetPrice));
    const accepted = candidates.filter((c) => {
      const deviation = Math.abs(c.assetPrice / reference - 1);
      if (deviation <= opts.maxDeviation) return true;
      problems.push({
        exchange: c.instrument.exchange,
        symbol: c.instrument.symbol,
        assetId: code,
        reason: `price ${c.assetPrice.toPrecision(6)} is ${pct(deviation)} from the cross-exchange median ${reference.toPrecision(6)}`,
      });
      return false;
    });
    const chosen = onePerExchange(accepted);
    const turnover = chosen.reduce((sum, c) => sum + (c.quote.turnover ?? 0), 0);
    if (chosen.length > 0) ranked.push({ code, turnover, reference, chosen });
  }

  ranked.sort((a, b) => b.turnover - a.turnover);
  const assets: UniverseAsset[] = ranked.slice(0, opts.size).map((r, i) => ({
    id: r.code,
    symbol: r.code,
    name: r.code,
    rank: i + 1,
    marketCapRank: null,
    marketCapUsd: null,
    priceUsd: r.reference,
    instruments: r.chosen.map((c) => ({ exchange: c.instrument.exchange, symbol: c.instrument.symbol })),
  }));
  return {
    source: 'volume',
    builtAt: opts.now ?? Date.now(),
    size: opts.size,
    assets,
    problems: problems.filter((p) => assets.some((a) => a.id === p.assetId)),
    warnings: [
      'ranked by 24 h perpetual turnover because CoinGecko data is unavailable; market cap is not shown',
    ],
  };
}

/**
 * Adds an exchange that joined after the universe was built (e.g. it was down at start-up),
 * matching its instruments to the existing assets with the same price check.
 */
export function extendUniverse(
  universe: UniverseInfo,
  exchange: ExchangeId,
  instruments: InstrumentInfo[],
  quotes: Map<string, Quote>,
  maxDeviation: number,
): UniverseInfo {
  const index = byAsset(instruments.filter((i) => i.exchange === exchange));
  const problems = universe.problems.filter((p) => p.exchange !== exchange);
  const assets = universe.assets.map((asset) => {
    const others = asset.instruments.filter((i) => i.exchange !== exchange);
    const codes = [asset.symbol, ...(OVERRIDES.aliases[asset.id] ?? [])];
    const accepted: Candidate[] = [];
    for (const instrument of codes.flatMap((c) => index.get(c) ?? [])) {
      const quote = quotes.get(quoteKey(exchange, instrument.symbol));
      if (!quote || !asset.priceUsd) continue;
      const assetPrice = quote.price / instrument.multiplier;
      const deviation = Math.abs(assetPrice / asset.priceUsd - 1);
      if (deviation > maxDeviation) {
        problems.push({
          exchange,
          symbol: instrument.symbol,
          assetId: asset.id,
          reason: `price ${assetPrice.toPrecision(6)} vs reference ${asset.priceUsd} (${pct(deviation)} apart)`,
        });
        continue;
      }
      accepted.push({ instrument, quote, assetPrice });
    }
    const chosen = onePerExchange(accepted).map((c) => ({ exchange, symbol: c.instrument.symbol }));
    const merged = [...others, ...chosen].sort(
      (a, b) => EXCHANGE_IDS.indexOf(a.exchange) - EXCHANGE_IDS.indexOf(b.exchange),
    );
    return { ...asset, instruments: merged };
  });
  return { ...universe, assets, problems };
}

/** Symbols of one exchange that belong to the universe. */
export function symbolsFor(universe: UniverseInfo, exchange: ExchangeId): string[] {
  return universe.assets.flatMap((a) =>
    a.instruments.filter((i) => i.exchange === exchange).map((i) => i.symbol),
  );
}
