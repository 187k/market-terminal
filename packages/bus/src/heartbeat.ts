import {
  APP_VERSION,
  PROCESS_NAMES,
  type Logger,
  type ProcessHeartbeat,
  type ProcessName,
  type ProcessStatus,
} from '@mip/core';
import { KEYS } from './keys.js';
import type { Redis } from './redis.js';

export interface HeartbeatOptions {
  intervalMs?: number;
  /** Key expiry; a process is reported as missing once its key expires. */
  ttlMs?: number;
}

/** Publishes `mip:proc:<name>` every few seconds. Returns a function that stops and removes it. */
export function startHeartbeat(
  redis: Redis,
  name: ProcessName,
  logger: Logger,
  options: HeartbeatOptions = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 5_000;
  const ttlMs = options.ttlMs ?? 15_000;
  const startedAt = Date.now();
  const beat = async () => {
    const hb: ProcessHeartbeat = { name, pid: process.pid, version: APP_VERSION, startedAt, ts: Date.now() };
    try {
      await redis.set(KEYS.processHeartbeat(name), JSON.stringify(hb), 'PX', ttlMs);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'heartbeat write failed');
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  return async () => {
    clearInterval(timer);
    await redis.del(KEYS.processHeartbeat(name)).catch(() => undefined);
  };
}

export async function readProcessStatuses(redis: Redis): Promise<ProcessStatus[]> {
  const raw = await redis.mget(...PROCESS_NAMES.map((n) => KEYS.processHeartbeat(n)));
  return PROCESS_NAMES.map((name, i): ProcessStatus => {
    const value = raw[i];
    if (!value) return { name, alive: false, pid: null, version: null, startedAt: null, lastSeenAt: null };
    const hb = JSON.parse(value) as ProcessHeartbeat;
    return {
      name,
      alive: true,
      pid: hb.pid,
      version: hb.version,
      startedAt: hb.startedAt,
      lastSeenAt: hb.ts,
    };
  });
}
