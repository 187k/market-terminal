import { Redis } from 'ioredis';
import type { Logger } from '@mip/core';

export type { Redis };

/**
 * Creates a Redis client that reconnects forever with capped backoff and logs
 * connection problems once per outage instead of once per retry.
 */
export function createRedis(url: string, logger: Logger, name: string): Redis {
  const log = logger.child({ component: 'redis', client: name });
  const redis = new Redis(url, {
    connectionName: name,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  let down = false;
  redis.on('ready', () => {
    if (down) log.info('redis connection restored');
    down = false;
  });
  redis.on('error', (err: Error) => {
    if (!down) log.error({ err: err.message }, 'redis connection error');
    down = true;
  });
  return redis;
}

export async function connectRedis(redis: Redis): Promise<void> {
  if (redis.status === 'wait') await redis.connect();
}
