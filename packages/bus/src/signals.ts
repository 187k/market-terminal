import type { ScannerId, ScannerStatusDto, SignalDto } from '@mip/core';
import { CHANNELS, KEYS } from './keys.js';
import type { Redis } from './redis.js';

export interface StoredSignals {
  ts: number;
  /** Active signals, newest first. */
  active: SignalDto[];
  /** Recently resolved signals, newest first (bounded). */
  recent: SignalDto[];
}

export async function writeSignals(redis: Redis, scanner: ScannerId, value: StoredSignals): Promise<void> {
  await redis.set(KEYS.signals(scanner), JSON.stringify(value));
}

export async function readSignals(redis: Redis, scanner: ScannerId): Promise<StoredSignals | null> {
  const raw = await redis.get(KEYS.signals(scanner));
  return raw ? (JSON.parse(raw) as StoredSignals) : null;
}

export interface StoredScannerStatus {
  ts: number;
  scanners: ScannerStatusDto[];
}

/** Expires if the engine stops, so the dashboard can tell "not running" from "no signals". */
export async function writeScannerStatus(
  redis: Redis,
  scanners: ScannerStatusDto[],
  ttlMs = 15_000,
): Promise<void> {
  const value: StoredScannerStatus = { ts: Date.now(), scanners };
  await redis.set(KEYS.scannerStatus, JSON.stringify(value), 'PX', ttlMs);
}

export async function readScannerStatus(redis: Redis): Promise<StoredScannerStatus | null> {
  const raw = await redis.get(KEYS.scannerStatus);
  return raw ? (JSON.parse(raw) as StoredScannerStatus) : null;
}

export async function publishSettingsChanged(redis: Redis, scanner: ScannerId): Promise<void> {
  await redis.publish(CHANNELS.settingsChanged, scanner);
}
