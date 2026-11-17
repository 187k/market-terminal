export interface BackoffOptions {
  /** Delay for the first retry. */
  baseMs: number;
  /** Upper bound for any delay. */
  maxMs: number;
  /**
   * Fraction of the delay that is randomised (0 = deterministic, 1 = "full jitter").
   * Jitter keeps many connections from reconnecting in lock-step after an outage.
   */
  jitter?: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000, jitter: 0.5 };

/** Exponential backoff: base * 2^attempt, capped at max, with partial jitter. `attempt` starts at 0. */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const jitter = Math.min(Math.max(options.jitter ?? 0.5, 0), 1);
  const exp = options.baseMs * 2 ** Math.max(0, Math.min(attempt, 30));
  const capped = Math.min(exp, options.maxMs);
  return Math.round(capped * (1 - jitter) + capped * jitter * random());
}
