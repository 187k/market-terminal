import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, type ConnectionStateEvent } from '@mip/core';
import { ConnectionEventWriter, type ConnectionEventSink } from './event-writer.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const event = (n: number): ConnectionStateEvent => ({
  exchange: 'bybit',
  connection: `linear#${n}`,
  state: 'open',
  reason: null,
  at: 1_000 + n,
});

let writer: ConnectionEventWriter | null = null;
afterEach(async () => {
  await writer?.close().catch(() => undefined);
  writer = null;
});

describe('ConnectionEventWriter', () => {
  it('writes buffered events in one batch', async () => {
    const batches: unknown[][] = [];
    const sink: ConnectionEventSink = {
      connectionEvent: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }) => void batches.push(data),
      },
    };
    writer = new ConnectionEventWriter(sink, logger, { flushIntervalMs: 60_000 });
    writer.push(event(1));
    writer.push(event(2));
    await writer.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { at: new Date(1_001), exchange: 'bybit', connection: 'linear#1', state: 'open', reason: null },
      { at: new Date(1_002), exchange: 'bybit', connection: 'linear#2', state: 'open', reason: null },
    ]);
    expect(writer.pending).toBe(0);
  });

  it('keeps events when the database is down and writes them once it is back', async () => {
    let up = false;
    const written: unknown[] = [];
    const sink: ConnectionEventSink = {
      connectionEvent: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }) => {
          if (!up) throw new Error('connection refused');
          written.push(...data);
        },
      },
    };
    writer = new ConnectionEventWriter(sink, logger, { flushIntervalMs: 60_000 });
    writer.push(event(1));
    await writer.flush();
    expect(writer.pending).toBe(1);
    writer.push(event(2));
    up = true;
    await writer.flush();
    expect(written).toHaveLength(2);
    expect(writer.pending).toBe(0);
  });

  it('bounds memory by dropping the oldest events', async () => {
    const sink: ConnectionEventSink = {
      connectionEvent: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => {
          throw new Error('down');
        },
      },
    };
    writer = new ConnectionEventWriter(sink, logger, { flushIntervalMs: 60_000, maxBuffered: 3 });
    for (let i = 0; i < 5; i++) writer.push(event(i));
    expect(writer.pending).toBe(3);
  });

  it('deletes events older than the retention period', async () => {
    const cutoffs: Date[] = [];
    const sink: ConnectionEventSink = {
      connectionEvent: {
        createMany: async () => undefined,
        deleteMany: async ({ where }) => {
          cutoffs.push(where.at.lt);
          return { count: 3 };
        },
      },
    };
    const now = Date.UTC(2026, 10, 18);
    writer = new ConnectionEventWriter(sink, logger, {
      flushIntervalMs: 60_000,
      retentionDays: 30,
      now: () => now,
    });
    expect(await writer.purge()).toBe(3);
    expect(cutoffs).toEqual([new Date(now - 30 * 86_400_000)]);
  });

  it('keeps everything without a retention period', async () => {
    let calls = 0;
    const sink: ConnectionEventSink = {
      connectionEvent: {
        createMany: async () => undefined,
        deleteMany: async () => {
          calls++;
          return { count: 0 };
        },
      },
    };
    writer = new ConnectionEventWriter(sink, logger, { flushIntervalMs: 60_000 });
    expect(await writer.purge()).toBe(0);
    expect(calls).toBe(0);
  });
});
