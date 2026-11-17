import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient };
export { signalRowToDto } from './signals.js';
export type {
  ConnectionEvent,
  Instrument,
  UniverseSnapshot,
  Signal,
  ScannerSetting,
  MarketSnapshot,
  Prisma,
} from './generated/prisma/client.js';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  // Prisma 7 changed pg pool defaults (no connect timeout, 10 s idle); set them explicitly.
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 300_000,
    max: 10,
  });
  return new PrismaClient({ adapter });
}

/** Cheap connectivity probe for health checks. */
export async function pingDatabase(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
