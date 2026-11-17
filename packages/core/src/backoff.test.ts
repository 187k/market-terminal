import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff.js';

describe('backoffDelay', () => {
  const opts = { baseMs: 100, maxMs: 1_000, jitter: 0 };

  it('doubles per attempt without jitter', () => {
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, opts))).toEqual([100, 200, 400, 800]);
  });

  it('caps at maxMs', () => {
    expect(backoffDelay(10, opts)).toBe(1_000);
    expect(backoffDelay(1_000, opts)).toBe(1_000);
  });

  it('keeps jittered delays within [capped*(1-j), capped]', () => {
    const j = { baseMs: 100, maxMs: 1_000, jitter: 0.5 };
    expect(backoffDelay(2, j, () => 0)).toBe(200);
    expect(backoffDelay(2, j, () => 1)).toBe(400);
    expect(backoffDelay(2, j, () => 0.5)).toBe(300);
  });
});
