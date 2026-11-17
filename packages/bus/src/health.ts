import type { ConnectionStateEvent, ConnectorHealth } from '@mip/core';
import { CHANNELS, KEYS } from './keys.js';
import type { Redis } from './redis.js';

interface StoredHealth {
  ts: number;
  exchanges: ConnectorHealth[];
}

/** Exchange health snapshot written by the collector; expires if the collector stops. */
export async function writeExchangeHealth(
  redis: Redis,
  exchanges: ConnectorHealth[],
  ttlMs = 10_000,
): Promise<void> {
  const value: StoredHealth = { ts: Date.now(), exchanges };
  await redis.set(KEYS.exchangeHealth, JSON.stringify(value), 'PX', ttlMs);
}

export async function readExchangeHealth(redis: Redis): Promise<StoredHealth | null> {
  const raw = await redis.get(KEYS.exchangeHealth);
  return raw ? (JSON.parse(raw) as StoredHealth) : null;
}

export async function publishConnectionEvent(redis: Redis, event: ConnectionStateEvent): Promise<void> {
  await redis.publish(CHANNELS.connectionEvents, JSON.stringify(event));
}
