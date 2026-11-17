import { readExchangeHealth, readProcessStatuses, type Redis } from '@mip/bus';
import type { ConnectionEventDto, SystemStatus } from '@mip/core';
import { pingDatabase, type PrismaClient } from '@mip/db';

/** Read side used by the API routes; an interface so routes can be tested without Redis or Postgres. */
export interface StatusSource {
  systemStatus(): Promise<SystemStatus>;
  connectionEvents(limit: number): Promise<ConnectionEventDto[]>;
  health(): Promise<{ db: boolean; redis: boolean }>;
}

export function createStatusSource(redis: Redis, prisma: PrismaClient): StatusSource {
  return {
    async systemStatus() {
      const [processes, health] = await Promise.all([readProcessStatuses(redis), readExchangeHealth(redis)]);
      return {
        serverTime: Date.now(),
        processes,
        exchanges: health?.exchanges ?? [],
        exchangesUpdatedAt: health?.ts ?? null,
      };
    },

    async connectionEvents(limit) {
      const rows = await prisma.connectionEvent.findMany({ orderBy: { at: 'desc' }, take: limit });
      return rows.map((r) => ({
        id: r.id.toString(),
        at: r.at.toISOString(),
        exchange: r.exchange,
        connection: r.connection,
        state: r.state,
        reason: r.reason,
      }));
    },

    async health() {
      const [db, redisOk] = await Promise.all([
        pingDatabase(prisma),
        redis
          .ping()
          .then((r) => r === 'PONG')
          .catch(() => false),
      ]);
      return { db, redis: redisOk };
    },
  };
}
