#!/usr/bin/env node
// Records real exchange payloads (REST responses and WebSocket messages) as test fixtures.
//
//   node tools/record.mjs <exchange> [seconds]
//
// Writes trimmed JSON to packages/connectors/src/<exchange>/fixtures/. Lists are cut down to a
// few symbols so fixtures stay small; WebSocket messages are kept per message kind (a few each).
// Public endpoints only; no API keys are used.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pick = (list, key, wanted) => list.filter((x) => wanted.includes(x[key]));

const EXCHANGES = {
  bybit: {
    symbols: ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT'],
    rest: (s) => [
      {
        name: 'instruments',
        url: 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000',
        trim: (j) => ({ ...j, result: { ...j.result, list: pick(j.result.list, 'symbol', s) } }),
      },
      {
        name: 'tickers',
        url: 'https://api.bybit.com/v5/market/tickers?category=linear',
        trim: (j) => ({ ...j, result: { ...j.result, list: pick(j.result.list, 'symbol', s) } }),
      },
      {
        name: 'open-interest',
        url: 'https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=5min&limit=2',
      },
      {
        name: 'funding-history',
        url: 'https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=2',
      },
    ],
    ws: (s) => ({
      url: 'wss://stream.bybit.com/v5/public/linear',
      subscribe: [JSON.stringify({ op: 'subscribe', args: s.map((x) => `tickers.${x}`) })],
      ping: () => JSON.stringify({ op: 'ping' }),
      keyOf: (m) => (m.topic ? `${m.topic}:${m.type}` : `op:${m.op}`),
    }),
  },

  binance: {
    symbols: ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT'],
    rest: (s) => [
      {
        name: 'exchange-info',
        url: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
        trim: (j) => ({
          ...j,
          assets: j.assets?.slice(0, 2),
          symbols: [
            ...pick(j.symbols, 'symbol', s),
            // one non-crypto contract, to test the TradFi filter
            ...j.symbols.filter((x) => x.contractType === 'TRADIFI_PERPETUAL').slice(0, 1),
          ],
        }),
      },
      {
        name: 'premium-index',
        url: 'https://fapi.binance.com/fapi/v1/premiumIndex',
        trim: (j) => pick(j, 'symbol', s),
      },
      {
        name: 'funding-info',
        url: 'https://fapi.binance.com/fapi/v1/fundingInfo',
        trim: (j) => j.slice(0, 5),
      },
      {
        name: 'ticker-24hr',
        url: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
        trim: (j) => pick(j, 'symbol', s),
      },
      {
        name: 'book-ticker',
        url: 'https://fapi.binance.com/fapi/v1/ticker/bookTicker',
        trim: (j) => pick(j, 'symbol', s),
      },
      { name: 'open-interest', url: 'https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT' },
    ],
    ws: (s) => {
      const l = s.map((x) => x.toLowerCase());
      return [
        {
          url: `wss://fstream.binance.com/public/stream?streams=${l.map((x) => `${x}@depth5@500ms`).join('/')}`,
          keyOf: (m) => (m.stream ? m.stream.split('@').slice(1).join('@') : 'other'),
        },
        {
          url: `wss://fstream.binance.com/market/stream?streams=${l.flatMap((x) => [`${x}@markPrice@1s`, `${x}@ticker`]).join('/')}`,
          keyOf: (m) => (m.stream ? m.stream.split('@').slice(1).join('@') : 'other'),
        },
      ];
    },
  },
};

Object.assign(EXCHANGES, {
  gate: {
    symbols: ['BTC_USDT', 'ETH_USDT', 'PEPE_USDT'],
    rest: (s) => [
      {
        name: 'contracts',
        url: 'https://api.gateio.ws/api/v4/futures/usdt/contracts',
        trim: (j) => [...pick(j, 'name', s), ...j.filter((x) => x.enable_decimal).slice(0, 1)],
      },
      {
        name: 'tickers',
        url: 'https://api.gateio.ws/api/v4/futures/usdt/tickers',
        trim: (j) => pick(j, 'contract', s),
      },
    ],
    ws: (s) => ({
      url: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
      subscribe: ['futures.tickers', 'futures.book_ticker'].map((channel) =>
        JSON.stringify({ time: Math.floor(Date.now() / 1000), channel, event: 'subscribe', payload: s }),
      ),
      ping: () => JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' }),
      keyOf: (m) => `${m.channel}:${m.event}`,
    }),
  },

  bitget: {
    symbols: ['BTCUSDT', 'ETHUSDT', 'PEPEUSDT'],
    rest: (s) => [
      {
        name: 'contracts',
        url: 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES',
        trim: (j) => ({
          ...j,
          data: [...pick(j.data, 'symbol', s), ...j.data.filter((x) => x.isRwa === 'YES').slice(0, 1)],
        }),
      },
      {
        name: 'tickers',
        url: 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES',
        trim: (j) => ({ ...j, data: pick(j.data, 'symbol', s) }),
      },
      {
        name: 'current-fund-rate',
        url: 'https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES',
        trim: (j) => ({ ...j, data: Array.isArray(j.data) ? pick(j.data, 'symbol', s) : j.data }),
      },
    ],
    ws: (s) => ({
      url: 'wss://ws.bitget.com/v2/ws/public',
      subscribe: [
        JSON.stringify({
          op: 'subscribe',
          args: s.map((instId) => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId })),
        }),
      ],
      ping: () => 'ping',
      pingMs: 25_000,
      keyOf: (m) => (m._raw ? 'raw' : m.event ? `event:${m.event}` : `${m.arg?.channel}:${m.action}`),
    }),
  },

  mexc: {
    symbols: ['BTC_USDT', 'ETH_USDT', 'PEPE_USDT'],
    rest: (s) => [
      {
        name: 'detail',
        url: `${process.env.MEXC_REST_URL ?? 'https://api.mexc.com'}/api/v1/contract/detail`,
        trim: (j) => ({ ...j, data: pick(j.data, 'symbol', s) }),
      },
      {
        name: 'ticker',
        url: `${process.env.MEXC_REST_URL ?? 'https://api.mexc.com'}/api/v1/contract/ticker`,
        trim: (j) => ({ ...j, data: pick(j.data, 'symbol', s) }),
      },
      {
        name: 'funding-rate',
        url: `${process.env.MEXC_REST_URL ?? 'https://api.mexc.com'}/api/v1/contract/funding_rate`,
        trim: (j) => ({ ...j, data: Array.isArray(j.data) ? pick(j.data, 'symbol', s) : j.data }),
      },
    ],
    ws: (s) => ({
      // Documented host; override with MEXC_WS_URL where it is blocked.
      url: process.env.MEXC_WS_URL ?? 'wss://contract.mexc.com/edge',
      subscribe: s.map((symbol) => JSON.stringify({ method: 'sub.ticker', param: { symbol } })),
      ping: () => JSON.stringify({ method: 'ping' }),
      pingMs: 15_000,
      keyOf: (m) => `${m.channel}`,
    }),
  },

  bingx: {
    symbols: ['BTC-USDT', 'ETH-USDT', '1000PEPE-USDT'],
    rest: (s) => [
      {
        name: 'contracts',
        url: 'https://open-api.bingx.com/openApi/swap/v2/quote/contracts',
        trim: (j) => ({ ...j, data: pick(j.data, 'symbol', s) }),
      },
      {
        name: 'premium-index',
        url: 'https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex',
        trim: (j) => ({ ...j, data: pick(j.data, 'symbol', s) }),
      },
      {
        name: 'ticker',
        url: 'https://open-api.bingx.com/openApi/swap/v2/quote/ticker',
        trim: (j) => ({ ...j, data: pick(j.data, 'symbol', s) }),
      },
      {
        name: 'open-interest',
        url: 'https://open-api.bingx.com/openApi/swap/v2/quote/openInterest?symbol=BTC-USDT',
      },
    ],
    ws: (s) => ({
      url: 'wss://open-api-swap.bingx.com/swap-market',
      gzip: true,
      subscribe: s.flatMap((sym) =>
        ['ticker', 'bookTicker', 'markPrice'].map((t) =>
          JSON.stringify({ id: `${sym}@${t}`, reqType: 'sub', dataType: `${sym}@${t}` }),
        ),
      ),
      serverPing: (text) => (text === 'Ping' ? 'Pong' : null),
      keyOf: (m) => (m.dataType ? m.dataType.split('@')[1] : m.id ? 'ack' : 'other'),
    }),
  },

  hyperliquid: {
    symbols: ['BTC', 'ETH', 'kPEPE'],
    rest: (s) => [
      {
        name: 'meta-and-asset-ctxs',
        url: 'https://api.hyperliquid.xyz/info',
        body: { type: 'metaAndAssetCtxs' },
        trim: ([meta, ctxs]) => {
          const idx = meta.universe
            .map((u, i) => (s.includes(u.name) || u.isDelisted ? i : -1))
            .filter((i) => i >= 0)
            .slice(0, 4);
          return [{ ...meta, universe: idx.map((i) => meta.universe[i]) }, idx.map((i) => ctxs[i])];
        },
      },
      {
        name: 'predicted-fundings',
        url: 'https://api.hyperliquid.xyz/info',
        body: { type: 'predictedFundings' },
        trim: (j) => j.filter(([coin]) => s.includes(coin)),
      },
    ],
    ws: (s) => ({
      url: 'wss://api.hyperliquid.xyz/ws',
      subscribe: s.flatMap((coin) =>
        ['activeAssetCtx', 'bbo', 'trades'].map((type) =>
          JSON.stringify({ method: 'subscribe', subscription: { type, coin } }),
        ),
      ),
      ping: () => JSON.stringify({ method: 'ping' }),
      pingMs: 30_000,
      keyOf: (m) => m.channel,
    }),
  },
});

async function recordRest(dir, calls) {
  for (const call of calls) {
    const res = await fetch(
      call.url,
      call.body
        ? { method: 'POST', body: JSON.stringify(call.body), headers: { 'content-type': 'application/json' } }
        : {},
    );
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error(`${call.name}: HTTP ${res.status}, not JSON: ${text.slice(0, 200)}`);
      continue;
    }
    const out = call.trim ? call.trim(json) : json;
    writeFileSync(path.join(dir, `rest-${call.name}.json`), JSON.stringify(out, null, 2) + '\n');
    console.log(`rest ${call.name}: HTTP ${res.status}, ${text.length} bytes`);
  }
}

function recordWs(dir, spec, index, seconds, perKey = 4) {
  return new Promise((resolve) => {
    const kept = new Map();
    let total = 0;
    const ws = new WebSocket(spec.url, { perMessageDeflate: false, headers: spec.headers ?? {} });
    let ping;
    ws.on('open', () => {
      for (const m of spec.subscribe ?? []) ws.send(m);
      if (spec.ping) ping = setInterval(() => ws.send(spec.ping()), spec.pingMs ?? 15_000);
    });
    ws.on('message', (data, isBinary) => {
      const text = spec.gzip && isBinary ? gunzipSync(data).toString('utf8') : data.toString('utf8');
      if (spec.serverPing && spec.serverPing(text)) {
        ws.send(spec.serverPing(text));
        return;
      }
      total++;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = { _raw: text };
      }
      const key = spec.keyOf ? spec.keyOf(msg) : 'all';
      const list = kept.get(key) ?? [];
      if (list.length < perKey) list.push(msg);
      kept.set(key, list);
    });
    ws.on('error', (err) => console.error(`ws#${index} error: ${err.message}`));
    const finish = () => {
      clearInterval(ping);
      ws.terminate();
      const out = Object.fromEntries(kept);
      writeFileSync(path.join(dir, `ws-${index}.json`), JSON.stringify(out, null, 2) + '\n');
      console.log(`ws#${index}: ${total} messages, kinds: ${[...kept.keys()].join(', ')}`);
      resolve();
    };
    setTimeout(finish, seconds * 1000);
  });
}

const [exchange, secondsArg] = process.argv.slice(2);
const cfg = EXCHANGES[exchange];
if (!cfg) {
  console.error(`usage: node tools/record.mjs <${Object.keys(EXCHANGES).join('|')}> [seconds]`);
  process.exit(1);
}
const dir = path.join(root, 'packages', 'connectors', 'src', exchange, 'fixtures');
mkdirSync(dir, { recursive: true });
await recordRest(dir, cfg.rest(cfg.symbols));
const wsSpecs = [cfg.ws(cfg.symbols)].flat();
await Promise.all(wsSpecs.map((spec, i) => recordWs(dir, spec, i, Number(secondsArg ?? 10))));
console.log(`fixtures written to ${path.relative(root, dir)}`);
