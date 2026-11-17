import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Workspace packages are resolved to their TypeScript sources, so tests never need a build.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mip\/core\/types$/, replacement: src('./packages/core/src/types/index.ts') },
      { find: /^@mip\/core$/, replacement: src('./packages/core/src/index.ts') },
      { find: /^@mip\/bus$/, replacement: src('./packages/bus/src/index.ts') },
      { find: /^@mip\/analytics$/, replacement: src('./packages/analytics/src/index.ts') },
      { find: /^@mip\/connectors$/, replacement: src('./packages/connectors/src/index.ts') },
      { find: /^@mip\/db$/, replacement: src('./packages/db/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
