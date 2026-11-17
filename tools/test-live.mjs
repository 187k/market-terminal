#!/usr/bin/env node
// Runs the opt-in live exchange tests (packages/connectors/src/live.test.ts).
//   npm run test:live                  all seven exchanges
//   npm run test:live -- bybit gate    a subset
import { spawnSync } from 'node:child_process';

const exchanges = process.argv.slice(2);
const result = spawnSync('npx', ['vitest', 'run', 'packages/connectors/src/live.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    LIVE_TESTS: '1',
    ...(exchanges.length ? { LIVE_EXCHANGES: exchanges.join(',') } : {}),
  },
});
process.exit(result.status ?? 1);
