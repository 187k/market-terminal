import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@mip/core';
import { originAllowed, RealtimeHub, type RealtimeClient, type TopicLoader } from './realtime.js';

const logger = createLogger({ service: 'test', level: 'silent' });

function client() {
  const got: unknown[] = [];
  const c: RealtimeClient = { send: (m) => got.push(JSON.parse(m)) };
  return { c, got };
}

/** Lets pending promise callbacks run without advancing fake time. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RealtimeHub', () => {
  it('reads a topic once per interval for all subscribers and skips unchanged payloads', async () => {
    let value = 1;
    const load = vi.fn(async () => ({ value }));
    const hub = new RealtimeHub((t) => (t === 'x' ? { load, intervalMs: 1_000 } : null), logger);
    const a = client();
    const b = client();
    expect(hub.subscribe(a.c, 'x')).toBe(true);
    await flush();
    expect(hub.subscribe(b.c, 'x')).toBe(true); // gets the last payload at once
    expect(a.got).toEqual([{ type: 'data', topic: 'x', data: { value: 1 } }]);
    expect(b.got).toEqual(a.got);

    await vi.advanceTimersByTimeAsync(1_000); // same value: no push
    expect(a.got).toHaveLength(1);
    value = 2;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a.got.at(-1)).toEqual({ type: 'data', topic: 'x', data: { value: 2 } });
    expect(b.got).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(3);
    hub.close();
  });

  it('stops reading when the last subscriber leaves', async () => {
    const load = vi.fn(async () => 1);
    const hub = new RealtimeHub(() => ({ load, intervalMs: 1_000 }), logger);
    const a = client();
    hub.subscribe(a.c, 'x');
    hub.subscribe(a.c, 'y');
    await flush();
    expect(hub.activeTopics).toBe(2);
    hub.unsubscribe(a.c, 'x');
    expect(hub.activeTopics).toBe(1);
    hub.remove(a.c);
    expect(hub.activeTopics).toBe(0);
    const calls = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(calls);
  });

  it('refuses unknown topics', () => {
    const hub = new RealtimeHub(() => null, logger);
    expect(hub.subscribe(client().c, 'nope')).toBe(false);
    expect(hub.activeTopics).toBe(0);
  });

  it('reports a failing read once and keeps retrying', async () => {
    let fail = true;
    const loader: TopicLoader = {
      load: async () => {
        if (fail) throw new Error('redis down');
        return 'ok';
      },
      intervalMs: 1_000,
    };
    const hub = new RealtimeHub(() => loader, logger);
    const a = client();
    hub.subscribe(a.c, 'x');
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(a.got).toEqual([
      { type: 'error', topic: 'x', message: 'The server could not read this data; retrying.' },
    ]);
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a.got.at(-1)).toEqual({ type: 'data', topic: 'x', data: 'ok' });
    hub.close();
  });
});

describe('originAllowed', () => {
  it('accepts same-host browsers and non-browser clients', () => {
    expect(originAllowed(undefined, 'localhost:3000')).toBe(true);
    expect(originAllowed('http://localhost:5173', 'localhost:5173')).toBe(true);
    // nginx forwards $host without the port
    expect(originAllowed('http://localhost:8080', 'localhost')).toBe(true);
  });

  it('rejects other hosts and garbage', () => {
    expect(originAllowed('https://evil.example', 'localhost:8080')).toBe(false);
    expect(originAllowed('null', 'localhost')).toBe(false);
    expect(originAllowed('http://localhost', undefined)).toBe(false);
  });
});
