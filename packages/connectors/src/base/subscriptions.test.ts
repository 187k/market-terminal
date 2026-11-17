import { afterEach, describe, expect, it } from 'vitest';
import {
  FAST_BACKOFF,
  silentLogger,
  startWsServer,
  waitFor,
  type TestWsServer,
} from '../test-support/servers.js';
import { batchMessages, SubscriptionManager, type SubscriptionManagerOptions } from './subscriptions.js';

let server: TestWsServer | null = null;
let manager: SubscriptionManager | null = null;

afterEach(async () => {
  await manager?.stop();
  manager = null;
  await server?.close();
  server = null;
});

const encode = (op: string) => (batch: string[]) => JSON.stringify({ op, args: batch });
const protocol = (maxItems: number) => ({
  subscribe: (t: readonly string[]) => batchMessages(t, { maxItems }, encode('subscribe')),
  unsubscribe: (t: readonly string[]) => batchMessages(t, { maxItems }, encode('unsubscribe')),
});

function create(url: string, extra: Partial<SubscriptionManagerOptions> = {}) {
  manager = new SubscriptionManager({
    name: 'test/linear',
    url,
    protocol: protocol(2),
    maxTopicsPerConnection: 3,
    maxConnections: 3,
    socket: { backoff: FAST_BACKOFF },
    logger: silentLogger,
    ...extra,
  });
  return manager;
}

/** Topics the server has seen subscribed (minus unsubscribed), per server connection. */
function topicsByConnection(s: TestWsServer): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const { conn, text } of s.received) {
    const msg = JSON.parse(text) as { op: string; args: string[] };
    const set = out.get(conn) ?? new Set<string>();
    for (const t of msg.args) {
      if (msg.op === 'subscribe') set.add(t);
      else set.delete(t);
    }
    out.set(conn, set);
  }
  return out;
}

const subscribedCount = (s: TestWsServer) =>
  s.received
    .filter((r) => r.text.includes('"subscribe"'))
    .reduce((n, r) => n + (JSON.parse(r.text).args as string[]).length, 0);

describe('SubscriptionManager', () => {
  it('spreads topics over the fewest connections and subscribes each one', async () => {
    server = await startWsServer();
    const m = create(server.url);
    const topics = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    expect(m.add(topics)).toEqual({ added: topics, rejected: [] });
    m.start();
    await waitFor(() => subscribedCount(server!) === 7, 3_000, 'all subscribed');
    const sizes = [...topicsByConnection(server).values()].map((s) => s.size).sort();
    expect(sizes).toEqual([1, 3, 3]);
    for (const r of server.received)
      expect((JSON.parse(r.text).args as string[]).length).toBeLessThanOrEqual(2);
    expect(
      m
        .health()
        .map((h) => h.topics)
        .sort(),
    ).toEqual([1, 3, 3]);
  });

  it('rejects topics beyond the connection limits', () => {
    const m = create('ws://127.0.0.1:1', { maxTopicsPerConnection: 2, maxConnections: 1 });
    expect(m.add(['a', 'b', 'c', 'a'])).toEqual({ added: ['a', 'b'], rejected: ['c'] });
    expect(m.capacity).toBe(2);
  });

  it('re-subscribes only the dropped connection, with its own topics', async () => {
    server = await startWsServer();
    const m = create(server.url, { maxTopicsPerConnection: 2 });
    m.add(['a', 'b', 'c', 'd']);
    m.start();
    await waitFor(() => subscribedCount(server!) === 4, 3_000, 'initial subscriptions');
    const before = topicsByConnection(server);
    const [droppedConn, droppedTopics] = [...before.entries()][0]!;
    server.connections[droppedConn]!.terminate();
    await waitFor(
      () => server!.connections.length === 3 && subscribedCount(server!) === 6,
      3_000,
      'resubscribe',
    );
    expect(topicsByConnection(server).get(2)).toEqual(droppedTopics);
    await waitFor(() => m.health().every((h) => h.state === 'open'), 3_000, 'all open');
  });

  it('adds topics to a live connection and unsubscribes removed ones', async () => {
    server = await startWsServer();
    const m = create(server.url);
    m.add(['a']);
    m.start();
    await waitFor(() => server!.received.length === 1);
    m.add(['b']);
    await waitFor(() => server!.received.length === 2);
    m.remove(['a']);
    await waitFor(() => server!.received.length === 3);
    expect(server.received.map((r) => JSON.parse(r.text))).toEqual([
      { op: 'subscribe', args: ['a'] },
      { op: 'subscribe', args: ['b'] },
      { op: 'unsubscribe', args: ['a'] },
    ]);
    expect(server.connections).toHaveLength(1);
    expect(m.topics()).toEqual(['b']);
  });

  it('closes a connection once its last topic is removed', async () => {
    server = await startWsServer();
    const m = create(server.url, { maxTopicsPerConnection: 1 });
    m.add(['a', 'b']);
    m.start();
    await waitFor(() => server!.received.length === 2);
    m.remove(['b']);
    await waitFor(() => m.health().length === 1);
    expect(m.topics()).toEqual(['a']);
  });

  it('paces subscribe messages to the configured send rate', async () => {
    server = await startWsServer();
    const m = create(server.url, {
      protocol: protocol(1),
      maxTopicsPerConnection: 10,
      sendRate: { limit: 2, windowMs: 200 },
    });
    m.add(['a', 'b', 'c', 'd', 'e', 'f']);
    const times: number[] = [];
    server.wss.on('connection', (s) => s.on('message', () => times.push(Date.now())));
    m.start();
    await waitFor(() => times.length === 6, 3_000, 'six paced messages');
    expect(times[5]! - times[0]!).toBeGreaterThanOrEqual(380);
  });
});

describe('batchMessages', () => {
  it('respects item and byte limits', () => {
    const enc = (b: string[]) => b.join(',');
    expect(batchMessages(['aa', 'bb', 'cc', 'dd', 'ee'], { maxItems: 2 }, enc)).toEqual([
      'aa,bb',
      'cc,dd',
      'ee',
    ]);
    expect(batchMessages(['aaaa', 'bbbb', 'cc'], { maxItems: 10, maxBytes: 9 }, enc)).toEqual([
      'aaaa,bbbb',
      'cc',
    ]);
    expect(batchMessages(['aaaa', 'bbbb'], { maxItems: 10, maxBytes: 5 }, enc)).toEqual(['aaaa', 'bbbb']);
    expect(batchMessages([], { maxItems: 2 }, enc)).toEqual([]);
  });
});
