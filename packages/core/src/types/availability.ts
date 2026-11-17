/**
 * Missing data is never replaced by a made-up value. A field is either available
 * (with the time it was observed) or unavailable with a machine-readable reason.
 */
export const UNAVAILABLE_REASONS = [
  /** The exchange does not publish this metric through its public API. */
  'not_provided',
  /** The exchange publishes it only to authenticated clients and no key is configured. */
  'requires_api_key',
  /** Supported, but no value has arrived yet since start-up or reconnect. */
  'not_received',
  /** A value exists but is older than the freshness limit for this field. */
  'stale',
  /** The exchange sent a value that failed validation. */
  'invalid',
  /** Needs history that has not accumulated yet (e.g. a 4 h change after a restart). */
  'warming_up',
  /** Collection is switched off by configuration. */
  'disabled',
  /** Not built yet in this version of the platform. */
  'not_implemented',
  /** Collection failed; see detail. */
  'error',
] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export interface Available<T> {
  readonly available: true;
  readonly value: T;
  /** Unix time in milliseconds at which the value was observed. */
  readonly ts: number;
}

export interface Unavailable {
  readonly available: false;
  readonly reason: UnavailableReason;
  readonly detail?: string;
}

export type Field<T> = Available<T> | Unavailable;

export function available<T>(value: T, ts: number): Available<T> {
  return { available: true, value, ts };
}

export function unavailable(reason: UnavailableReason, detail?: string): Unavailable {
  return detail === undefined ? { available: false, reason } : { available: false, reason, detail };
}

/** Returns the value of an available field, or null. */
export function valueOrNull<T>(field: Field<T>): T | null {
  return field.available ? field.value : null;
}
