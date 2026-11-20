#!/usr/bin/env node
// Records one real candle (kline) response per exchange as a test fixture for
// packages/connectors/src/klines/. ETH perpetual, 5-minute candles, at most 5 of them.
//
//   node tools/record-klines.mjs [exchange ...]
//
// Public endpoints only, one request per exchange. Do not run it while an exchange has banned
// this IP (check `mip:pause:<exchange>` in Redis first): requests during a ban extend it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'packages/connectors/src/klines/fixtures');
const now = Date.now();
const fiveMin = 300_000;
const start = now - 5 * fiveMin;

const EXCHANGES = {
  bybit: {
    url: 'https://api.bybit.com/v5/market/kline?category=linear&symbol=ETHUSDT&interval=5&limit=5',
  },
  binance: { url: 'https://fapi.binance.com/fapi/v1/klines?symbol=ETHUSDT&interval=5m&limit=5' },
  mexc: {
    url: `https://api.mexc.com/api/v1/contract/kline/ETH_USDT?interval=Min5&start=${Math.floor(start / 1000)}&end=${Math.floor(now / 1000)}`,
  },
  hyperliquid: {
    url: 'https://api.hyperliquid.xyz/info',
    body: { type: 'candleSnapshot', req: { coin: 'ETH', interval: '5m', startTime: start, endTime: now } },
  },
  bitget: {
    url: 'https://api.bitget.com/api/v2/mix/market/candles?symbol=ETHUSDT&productType=USDT-FUTURES&granularity=5m&limit=5',
  },
  bingx: {
    url: 'https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=ETH-USDT&interval=5m&limit=5',
  },
  gate: {
    url: 'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=ETH_USDT&interval=5m&limit=5',
    headers: { 'X-Gate-Size-Decimal': '1' },
  },
};

const wanted = process.argv.slice(2);
mkdirSync(out, { recursive: true });
for (const [ex, req] of Object.entries(EXCHANGES)) {
  if (wanted.length && !wanted.includes(ex)) continue;
  try {
    const res = await fetch(req.url, {
      method: req.body ? 'POST' : 'GET',
      headers: { ...(req.body ? { 'content-type': 'application/json' } : {}), ...req.headers },
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`${ex}: HTTP ${res.status}; nothing written`);
      continue;
    }
    const body = await res.json();
    writeFileSync(path.join(out, `${ex}.json`), JSON.stringify(body, null, 2) + '\n');
    console.log(`${ex}: written`);
  } catch (err) {
    console.error(`${ex}: ${err.message}`);
  }
}
