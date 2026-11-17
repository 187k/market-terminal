#!/usr/bin/env node
// Records public trade messages from every exchange's WebSocket as test fixtures:
//   node tools/record-trades.mjs [seconds]
// Writes packages/connectors/src/<exchange>/fixtures/ws-trades.json (first messages per kind).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seconds = Number(process.argv[2] ?? 15);
const now = () => Math.floor(Date.now() / 1000);

const SPECS = {
  bybit: {
    url: 'wss://stream.bybit.com/v5/public/linear',
    sub: [JSON.stringify({ op: 'subscribe', args: ['publicTrade.BTCUSDT', 'publicTrade.ETHUSDT'] })],
    key: (m) => (m.topic ? `${m.topic.split('.')[0]}:${m.type}` : `op:${m.op}`),
  },
  binance: {
    url: 'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade',
    sub: [],
    key: (m) => (m.stream ? m.stream.split('@')[1] : 'other'),
  },
  mexc: {
    url: process.env.MEXC_WS_URL ?? 'wss://contract.mexc.com/edge',
    sub: ['BTC_USDT', 'ETH_USDT'].map((symbol) => JSON.stringify({ method: 'sub.deal', param: { symbol } })),
    ping: () => JSON.stringify({ method: 'ping' }),
    key: (m) => m.channel,
  },
  bitget: {
    url: 'wss://ws.bitget.com/v2/ws/public',
    sub: [
      JSON.stringify({
        op: 'subscribe',
        args: ['BTCUSDT', 'ETHUSDT'].map((instId) => ({
          instType: 'USDT-FUTURES',
          channel: 'trade',
          instId,
        })),
      }),
    ],
    ping: () => 'ping',
    key: (m) => (m._raw ? 'raw' : m.event ? `event:${m.event}` : `${m.arg?.channel}:${m.action}`),
  },
  bingx: {
    url: 'wss://open-api-swap.bingx.com/swap-market',
    gzip: true,
    sub: ['BTC-USDT', 'ETH-USDT'].map((s) =>
      JSON.stringify({ id: s, reqType: 'sub', dataType: `${s}@trade` }),
    ),
    serverPing: (t) => (t === 'Ping' ? 'Pong' : null),
    key: (m) => (m.dataType ? m.dataType.split('@')[1] : 'ack'),
  },
  gate: {
    url: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    sub: [
      JSON.stringify({
        time: now(),
        channel: 'futures.trades',
        event: 'subscribe',
        payload: ['BTC_USDT', 'ETH_USDT'],
      }),
    ],
    key: (m) => `${m.channel}:${m.event}`,
  },
};

function record(exchange, spec) {
  return new Promise((resolve) => {
    const kept = new Map();
    let total = 0;
    const ws = new WebSocket(spec.url, { perMessageDeflate: false });
    let ping;
    ws.on('open', () => {
      for (const m of spec.sub) ws.send(m);
      if (spec.ping) ping = setInterval(() => ws.send(spec.ping()), 10_000);
    });
    ws.on('message', (data, isBinary) => {
      const text = spec.gzip && isBinary ? gunzipSync(data).toString('utf8') : data.toString('utf8');
      const reply = spec.serverPing?.(text);
      if (reply) return void ws.send(reply);
      total++;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = { _raw: text };
      }
      const k = spec.key(msg);
      const list = kept.get(k) ?? [];
      if (list.length < 4) list.push(msg);
      kept.set(k, list);
    });
    ws.on('error', (e) => console.error(`${exchange}: ${e.message}`));
    setTimeout(() => {
      clearInterval(ping);
      ws.terminate();
      const file = path.join(root, 'packages', 'connectors', 'src', exchange, 'fixtures', 'ws-trades.json');
      writeFileSync(file, JSON.stringify(Object.fromEntries(kept), null, 2) + '\n');
      console.log(`${exchange}: ${total} messages, kinds ${[...kept.keys()].join(', ')}`);
      resolve();
    }, seconds * 1000);
  });
}

await Promise.all(Object.entries(SPECS).map(([e, s]) => record(e, s)));
