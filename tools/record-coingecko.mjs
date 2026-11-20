#!/usr/bin/env node
// Records real CoinGecko responses as test fixtures for packages/connectors/src/coingecko/:
//   markets.json  /coins/markets for three coins, with the 7-day sparkline and 1h/24h/7d changes
//   global.json   /global (total market cap, volume, dominance)
//
//   node tools/record-coingecko.mjs
//
// Keyless public API, two requests. Keyless access allows about 5 calls a minute per IP and the
// collector uses the same budget, so do not run this in a loop.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'packages/connectors/src/coingecko/fixtures');
const base = 'https://api.coingecko.com/api/v3';

const REQUESTS = {
  markets: `${base}/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=1h,24h,7d`,
  global: `${base}/global`,
};

mkdirSync(out, { recursive: true });
for (const [name, url] of Object.entries(REQUESTS)) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`${name}: HTTP ${res.status}; nothing written`);
    continue;
  }
  const body = await res.json();
  writeFileSync(path.join(out, `${name}.json`), JSON.stringify(body, null, 2) + '\n');
  console.log(`${name}: written`);
}
