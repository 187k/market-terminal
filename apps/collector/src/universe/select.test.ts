import { describe, expect, it } from 'vitest';
import type { ExchangeId, InstrumentInfo } from '@mip/core';
import type { CoinMarket } from '@mip/connectors';
import {
  extendUniverse,
  quoteKey,
  selectByMarketCap,
  selectByVolume,
  symbolsFor,
  type Quote,
} from './select.js';

function inst(exchange: ExchangeId, symbol: string, asset: string, multiplier = 1): InstrumentInfo {
  return {
    exchange,
    symbol,
    base: multiplier === 1 ? asset : `${multiplier}${asset}`,
    asset,
    multiplier,
    quote: 'USDT',
    contractSize: 1,
    tickSize: null,
    maxLeverage: { available: false, reason: 'not_provided' },
    indexKind: 'index',
    launchTime: null,
    url: '',
  };
}

function coin(id: string, symbol: string, price: number, cap: number, rank: number): CoinMarket {
  return {
    id,
    symbol,
    name: id,
    current_price: price,
    market_cap: cap,
    market_cap_rank: rank,
    total_volume: null,
  };
}

const instruments = [
  inst('bybit', 'BTCUSDT', 'BTC'),
  inst('binance', 'BTCUSDT', 'BTC'),
  inst('bybit', 'USDCUSDT', 'USDC'),
  inst('bybit', '1000PEPEUSDT', 'PEPE', 1000),
  inst('binance', '1000PEPEUSDT', 'PEPE', 1000),
  inst('binance', 'TONUSDT', 'TON'), // a different "TON" than CoinGecko's top coin
  inst('bybit', 'ETHUSDT', 'ETH'),
  inst('bybit', 'ETH2USDT', 'ETH'), // second listing on the same exchange (fictional)
];

const quotes = new Map<string, Quote>([
  [quoteKey('bybit', 'BTCUSDT'), { price: 65_000, turnover: 4e9 }],
  [quoteKey('binance', 'BTCUSDT'), { price: 65_010, turnover: 9e9 }],
  [quoteKey('bybit', 'USDCUSDT'), { price: 1, turnover: 1e6 }],
  [quoteKey('bybit', '1000PEPEUSDT'), { price: 0.00376, turnover: 6e7 }],
  [quoteKey('binance', '1000PEPEUSDT'), { price: 0.003761, turnover: 9e7 }],
  [quoteKey('binance', 'TONUSDT'), { price: 0.0004, turnover: 1e5 }],
  [quoteKey('bybit', 'ETHUSDT'), { price: 1818, turnover: 1.8e9 }],
  [quoteKey('bybit', 'ETH2USDT'), { price: 1817, turnover: 1e3 }],
]);

const coins = [
  coin('bitcoin', 'btc', 64_990, 1.3e12, 1),
  coin('ethereum', 'eth', 1819, 2.2e11, 2),
  coin('usd-coin', 'usdc', 1, 7e10, 6),
  coin('the-open-network', 'ton', 1.9, 5e9, 30),
  coin('pepe', 'pepe', 0.00000377, 1.6e9, 60),
  coin('no-perp-coin', 'npc', 3, 1e9, 70),
];

const opts = { size: 10, instruments, quotes, maxDeviation: 0.15, now: 1 };

describe('selectByMarketCap', () => {
  it('ranks by market cap, verifies prices and maps multipliers', () => {
    const u = selectByMarketCap(coins, new Set(['usd-coin']), opts);
    expect(u.assets.map((a) => `${a.rank}:${a.symbol}`)).toEqual(['1:BTC', '2:ETH', '3:PEPE']);
    const pepe = u.assets.find((a) => a.symbol === 'PEPE')!;
    expect(pepe.instruments).toEqual([
      { exchange: 'bybit', symbol: '1000PEPEUSDT' },
      { exchange: 'binance', symbol: '1000PEPEUSDT' },
    ]);
    expect(pepe).toMatchObject({ id: 'pepe', marketCapRank: 60, marketCapUsd: 1.6e9, priceUsd: 0.00000377 });
  });

  it('rejects a ticker collision and reports it instead of mapping it', () => {
    const u = selectByMarketCap(coins, new Set(), opts);
    expect(u.assets.find((a) => a.symbol === 'TON')).toBeUndefined();
    expect(u.problems).toContainEqual(
      expect.objectContaining({ exchange: 'binance', symbol: 'TONUSDT', assetId: 'the-open-network' }),
    );
  });

  it('rejects one exchange that disagrees with the others even if CoinGecko is stale', () => {
    const extra = [...instruments, inst('gate', 'BTC_USDT', 'BTC')];
    const q = new Map(quotes);
    q.set(quoteKey('gate', 'BTC_USDT'), { price: 80_000, turnover: 1e9 }); // 23 % above the others
    const u = selectByMarketCap(coins, new Set(['usd-coin']), {
      ...opts,
      instruments: extra,
      quotes: q,
      referenceAgeMs: 5 * 3_600_000,
    });
    expect(u.assets[0]!.instruments.map((i) => i.exchange)).toEqual(['bybit', 'binance']);
    expect(u.problems).toContainEqual(expect.objectContaining({ exchange: 'gate', symbol: 'BTC_USDT' }));
  });

  it('accepts a coin that moved since a stale CoinGecko snapshot when all exchanges agree', () => {
    const moved = [coin('bitcoin', 'btc', 52_000, 1.3e12, 1)]; // 20 % below today's 65k
    expect(selectByMarketCap(moved, new Set(), { ...opts, referenceAgeMs: 0 }).assets).toHaveLength(0);
    const u = selectByMarketCap(moved, new Set(), { ...opts, referenceAgeMs: 17 * 3_600_000 });
    expect(u.assets.map((a) => a.symbol)).toEqual(['BTC']);
    expect(u.warnings.some((w) => w.includes('17 h old'))).toBe(true);
    // a collision is still caught: a "BTC" priced 1000x off
    const q = new Map(quotes);
    q.set(quoteKey('bybit', 'BTCUSDT'), { price: 65, turnover: 1 });
    const v = selectByMarketCap(moved, new Set(), { ...opts, quotes: q, referenceAgeMs: 17 * 3_600_000 });
    expect(v.assets[0]!.instruments).toEqual([{ exchange: 'binance', symbol: 'BTCUSDT' }]);
  });

  it('keeps one instrument per exchange, the most traded', () => {
    const eth = selectByMarketCap(coins, new Set(), opts).assets.find((a) => a.symbol === 'ETH')!;
    expect(eth.instruments).toEqual([{ exchange: 'bybit', symbol: 'ETHUSDT' }]);
  });

  it('stops at N and warns when fewer assets match', () => {
    expect(selectByMarketCap(coins, new Set(['usd-coin']), { ...opts, size: 2 }).assets).toHaveLength(2);
    const u = selectByMarketCap(coins, new Set(['usd-coin']), { ...opts, size: 5 });
    expect(u.warnings).toEqual(['only 3 of 5 assets could be matched to perpetuals']);
  });

  it('lists symbols per exchange', () => {
    const u = selectByMarketCap(coins, new Set(['usd-coin']), opts);
    expect(symbolsFor(u, 'binance')).toEqual(['BTCUSDT', '1000PEPEUSDT']);
  });
});

describe('selectByVolume', () => {
  it('ranks by summed turnover, skips stablecoins and rejects price outliers', () => {
    const extra = [...instruments, inst('gate', 'PEPE_USDT', 'PEPE')];
    const q = new Map(quotes);
    q.set(quoteKey('gate', 'PEPE_USDT'), { price: 0.00376, turnover: 1e9 }); // unscaled: 1000x off
    const u = selectByVolume({ ...opts, instruments: extra, quotes: q });
    expect(u.source).toBe('volume');
    expect(u.assets.map((a) => a.symbol)).toEqual(['BTC', 'ETH', 'PEPE', 'TON']);
    expect(u.assets.find((a) => a.symbol === 'PEPE')!.instruments.map((i) => i.exchange)).toEqual([
      'bybit',
      'binance',
    ]);
    expect(u.problems).toContainEqual(expect.objectContaining({ exchange: 'gate', symbol: 'PEPE_USDT' }));
    expect(u.assets[0]!.marketCapUsd).toBeNull();
  });
});

describe('extendUniverse', () => {
  it('maps a late exchange onto existing assets with the same price check', () => {
    const base = selectByMarketCap(coins, new Set(['usd-coin']), {
      ...opts,
      instruments: instruments.filter((i) => i.exchange === 'bybit'),
    });
    expect(symbolsFor(base, 'binance')).toEqual([]);
    const ext = extendUniverse(base, 'binance', instruments, quotes, 0.15);
    expect(symbolsFor(ext, 'binance')).toEqual(['BTCUSDT', '1000PEPEUSDT']);
    expect(ext.assets[0]!.instruments.map((i) => i.exchange)).toEqual(['bybit', 'binance']);
  });
});
