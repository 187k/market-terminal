import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pauseSharedLimiter, RateLimitAbortedError, RateLimiter, sharedRateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Starts acquires and records the order in which they resolve. */
  function track(promises: Promise<unknown>[]) {
    const done: number[] = [];
    promises.forEach(
      (p, i) =>
        void p.then(
          () => done.push(i),
          () => done.push(-1 - i),
        ),
    );
    return done;
  }

  it('lets requests through up to the limit, then waits for the window to slide', async () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 3, windowMs: 1_000 }], headroom: 1 });
    const done = track([rl.acquire(), rl.acquire(), rl.acquire(), rl.acquire()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual([0, 1, 2, 3]);
  });

  it('applies headroom to the configured limit', () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 10, windowMs: 1_000 }], headroom: 0.8 });
    let n = 0;
    while (rl.tryAcquire()) n++;
    expect(n).toBe(8);
    expect(rl.stats().windows[0]).toMatchObject({ limit: 10, effectiveLimit: 8, used: 8 });
  });

  it('enforces every window (per-second and per-minute)', async () => {
    const rl = new RateLimiter({
      name: 't',
      windows: [
        { limit: 2, windowMs: 100 },
        { limit: 3, windowMs: 1_000 },
      ],
      headroom: 1,
    });
    const done = track([rl.acquire(), rl.acquire(), rl.acquire(), rl.acquire()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toEqual([0, 1, 2]); // per-second window freed, per-minute window now full
    await vi.advanceTimersByTimeAsync(800);
    expect(done).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toEqual([0, 1, 2, 3]);
  });

  it('counts request weights', async () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 10, windowMs: 1_000 }], headroom: 1 });
    const done = track([rl.acquire(6), rl.acquire(5)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toEqual([0, 1]);
  });

  it('serves higher priority waiters first', async () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 1, windowMs: 100 }], headroom: 1 });
    await rl.acquire();
    const done = track([
      rl.acquire(1, { priority: 'low' }),
      rl.acquire(1, { priority: 'normal' }),
      rl.acquire(1, { priority: 'high' }),
    ]);
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toEqual([2, 1, 0]);
  });

  it('pause() holds all requests and never shortens an existing pause', async () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 100, windowMs: 1_000 }], headroom: 1 });
    rl.pause(500);
    rl.pause(100);
    expect(rl.pausedUntil).toBe(Date.now() + 500);
    const done = track([rl.acquire()]);
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual([0]);
    expect(rl.pausedUntil).toBeNull();
  });

  it('removes aborted waiters without blocking the queue', async () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 1, windowMs: 100 }], headroom: 1 });
    await rl.acquire();
    const ac = new AbortController();
    const aborted = rl.acquire(1, { signal: ac.signal });
    const next = rl.acquire();
    ac.abort();
    await expect(aborted).rejects.toBeInstanceOf(RateLimitAbortedError);
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toBeUndefined();
  });

  it('rejects a cost that can never fit', async () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 5, windowMs: 1_000 }], headroom: 1 });
    await expect(rl.acquire(6)).rejects.toThrow(/exceeds window limit/);
  });

  it('close() rejects everyone still waiting', async () => {
    const rl = new RateLimiter({ name: 't', windows: [{ limit: 1, windowMs: 1_000 }], headroom: 1 });
    await rl.acquire();
    const waiting = rl.acquire();
    rl.close();
    await expect(waiting).rejects.toBeInstanceOf(RateLimitAbortedError);
  });
});

describe('shared limiters', () => {
  it('honours a pause recorded before the limiter exists (ban from a previous process)', () => {
    const until = Date.now() + 60_000;
    pauseSharedLimiter('test/pending', until);
    const rl = sharedRateLimiter({ name: 'test/pending', windows: [{ limit: 10, windowMs: 1_000 }] });
    expect(rl.pausedUntil).toBeGreaterThanOrEqual(until - 5);
    expect(rl.tryAcquire()).toBe(false);
    // the same limiter is returned for the same name
    expect(sharedRateLimiter({ name: 'test/pending', windows: [{ limit: 1, windowMs: 1 }] })).toBe(rl);
  });

  it('pauses an existing shared limiter immediately', () => {
    const rl = sharedRateLimiter({ name: 'test/existing', windows: [{ limit: 10, windowMs: 1_000 }] });
    expect(rl.tryAcquire()).toBe(true);
    pauseSharedLimiter('test/existing', Date.now() + 30_000);
    expect(rl.tryAcquire()).toBe(false);
  });
});
