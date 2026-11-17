#!/usr/bin/env node
// Captures the market view the engine reads (snapshots of every exchange, instruments, universe)
// from Redis into a fixture for scanner replay tests.
//
//   node tools/record-view.mjs [rowsPerExchange] [output]
//
// Uses `docker exec mip-redis-1 redis-cli`, so the collector must be running in Docker.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [limitArg, outArg] = process.argv.slice(2);
const limit = Number(limitArg ?? 40);
const out = outArg ?? path.join(root, 'apps', 'engine', 'src', 'fixtures', 'market-view.json');
const get = (key) => {
  const raw = execFileSync('docker', ['exec', 'mip-redis-1', 'redis-cli', 'GET', key], {
    encoding: 'utf8',
  }).trim();
  return raw ? JSON.parse(raw) : null;
};

const exchanges = ['bybit', 'binance', 'mexc', 'hyperliquid', 'bitget', 'bingx', 'gate'];
const universe = get('mip:universe');
const instruments = get('mip:instruments');
// keep the first N universe assets so the same assets appear on every exchange
const keepAssets = new Set(universe.assets.slice(0, limit).map((a) => a.id));
const keepKeys = new Set(
  universe.assets
    .filter((a) => keepAssets.has(a.id))
    .flatMap((a) => a.instruments.map((i) => `${i.exchange}:${i.symbol}`)),
);
const snapshots = exchanges
  .map((e) => get(`mip:market:${e}`))
  .filter(Boolean)
  .map((s) => ({ ...s, rows: s.rows.filter((r) => keepKeys.has(`${s.exchange}:${r.symbol}`)) }));
const fixture = {
  recordedAt: new Date().toISOString(),
  snapshots,
  instruments: {
    ...instruments,
    instruments: Object.fromEntries(
      Object.entries(instruments.instruments).map(([e, list]) => [
        e,
        list.filter((i) => keepKeys.has(`${e}:${i.symbol}`)),
      ]),
    ),
  },
  universe: { ...universe, assets: universe.assets.filter((a) => keepAssets.has(a.id)) },
};
writeFileSync(out, JSON.stringify(fixture) + '\n');
console.log(
  `wrote ${path.relative(root, out)}: ${snapshots.map((s) => `${s.exchange} ${s.rows.length}`).join(', ')}; ${fixture.universe.assets.length} assets`,
);
