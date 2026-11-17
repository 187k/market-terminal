import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env itself. Use the repository root .env when it exists;
// in Docker the variables come from the container environment instead.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` does not need a database; migrate commands fail clearly without one.
    url: process.env.DATABASE_URL ?? '',
  },
});
