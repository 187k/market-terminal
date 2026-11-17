import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { sleep } from '@mip/core';
import {
  FAST_BACKOFF,
  silentLogger,
  startWsServer,
  waitFor,
  type TestWsServer,
} from '../test-support/servers.js';
import {
  gunzipDecoder,
  ManagedWebSocket,
  type ManagedWebSocketOptions,
  type WsStateChange,
} from './ws-client.js';

let server: TestWsServer | null = null;
let client: ManagedWebSocket | null = null;

afterEach(async () => {
  await client?.stop();
  client = null;
  await server?.close();
  server = null;
});

function connect(url: string, extra: Partial<ManagedWebSocketOptions> = {}) {
  const messages: string[] = [];
  const states: WsStateChange[] = [];
  client = new ManagedWebSocket({
    name: 'test#0',
    url,
    logger: silentLogger,
    backoff: FAST_BACKOFF,
    ...extra,
  });
  client.on('message', (m) => messages.push(m.text));
  client.on('state', (s) => states.push(s));
  client.start();
  return { ws: client, messages, states };
}

describe('ManagedWebSocket', () => {
  it('connects and emits messages', async () => {
    server = await startWsServer();
    server.wss.on('connection', (s) => s.send('hello'));
    const { ws, messages, states } = connect(server.url);
    await waitFor(() => messages.length === 1, 3_000, 'first message');
    expect(messages).toEqual(['hello']);
    expect(states.map((s) => s.state)).toEqual(['connecting', 'open']);
    expect(ws.health()).toMatchObject({ state: 'open', messages: 1, reconnects: 0 });
  });

  it('reconnects after the server drops the connection and re-runs onOpen', async () => {
    server = await startWsServer();
    const { ws, states } = connect(server.url, {
      onOpen: ({ send, isReconnect }) => void send(`subscribe:${isReconnect ? 'again' : 'first'}`),
    });
    await waitFor(() => server!.received.length === 1, 3_000, 'first subscribe');
    server.connections[0]!.terminate();
    await waitFor(() => server!.received.length === 2, 3_000, 'resubscribe');
    expect(server.received).toEqual([
      { conn: 0, text: 'subscribe:first' },
      { conn: 1, text: 'subscribe:again' },
    ]);
    expect(ws.state).toBe('open');
    expect(ws.health().reconnects).toBe(1);
    expect(states.map((s) => s.state)).toEqual(['connecting', 'open', 'reconnecting', 'connecting', 'open']);
    expect(states[2]!.reason).toMatch(/closed \(code 1006\); retry in \d+ ms/);
  });

  it('survives repeated drops', async () => {
    server = await startWsServer();
    const { ws } = connect(server.url, { onOpen: ({ send }) => void send('sub') });
    for (let i = 0; i < 5; i++) {
      await waitFor(() => server!.received.length === i + 1, 3_000, `subscribe ${i}`);
      server.connections[i]!.terminate();
    }
    await waitFor(() => server!.received.length === 6, 3_000, 'final subscribe');
    expect(ws.state).toBe('open');
    expect(ws.health().reconnects).toBe(5);
  });

  it('reconnects when the connection goes silent', async () => {
    server = await startWsServer();
    const { states } = connect(server.url, { staleAfterMs: 200 });
    await waitFor(() => server!.connections.length >= 2, 3_000, 'reconnect after stale');
    const reconnect = states.find((s) => s.state === 'reconnecting');
    expect(reconnect?.reason).toMatch(/^stale: no data for \d+ ms/);
  });

  it('sends application-level heartbeats', async () => {
    server = await startWsServer();
    connect(server.url, { heartbeat: { intervalMs: 50, message: () => '{"op":"ping"}' } });
    await waitFor(() => server!.received.length >= 3, 3_000, 'three pings');
    expect(new Set(server.received.map((r) => r.text))).toEqual(new Set(['{"op":"ping"}']));
  });

  it('keeps a quiet connection alive with protocol pings', async () => {
    server = await startWsServer();
    const { ws } = connect(server.url, { heartbeat: { intervalMs: 50 }, staleAfterMs: 200 });
    await waitFor(() => ws.state === 'open');
    await sleep(600);
    expect(server.connections).toHaveLength(1);
    expect(ws.health().reconnects).toBe(0);
  });

  it('answers server pings without emitting them as data', async () => {
    server = await startWsServer();
    server.wss.on('connection', (s) => {
      s.send('Ping');
      s.send('{"data":1}');
    });
    const { messages } = connect(server.url, { serverPing: (t) => (t === 'Ping' ? 'Pong' : null) });
    await waitFor(() => messages.length === 1 && server!.received.length === 1, 3_000, 'pong + data');
    expect(server.received[0]!.text).toBe('Pong');
    expect(messages).toEqual(['{"data":1}']);
  });

  it('decodes gzip-compressed binary frames', async () => {
    server = await startWsServer();
    server.wss.on('connection', (s) => s.send(gzipSync('{"compressed":true}'), { binary: true }));
    const { messages } = connect(server.url, { decode: gunzipDecoder });
    await waitFor(() => messages.length === 1, 3_000, 'decoded message');
    expect(JSON.parse(messages[0]!)).toEqual({ compressed: true });
  });

  it('records undecodable frames as errors instead of crashing', async () => {
    server = await startWsServer();
    server.wss.on('connection', (s) => {
      s.send(Buffer.from('not gzip'), { binary: true });
      s.send(gzipSync('ok'), { binary: true });
    });
    const { ws, messages } = connect(server.url, { decode: gunzipDecoder });
    await waitFor(() => messages.length === 1, 3_000, 'valid frame after bad one');
    expect(ws.health().lastError).toMatch(/decode failed/);
  });

  it('retries when the handshake is rejected', async () => {
    let attempts = 0;
    server = await startWsServer({
      verifyClient: (_info, cb) => (++attempts <= 2 ? cb(false, 403) : cb(true)),
    });
    const { ws } = connect(server.url);
    await waitFor(() => ws.state === 'open', 3_000, 'open after rejections');
    expect(attempts).toBe(3);
    expect(ws.health().lastError).toMatch(/403/);
  });

  it('stop() closes the connection and does not reconnect', async () => {
    server = await startWsServer();
    const { ws, states } = connect(server.url);
    await waitFor(() => ws.state === 'open');
    await ws.stop();
    await sleep(200);
    expect(ws.state).toBe('stopped');
    expect(server.connections).toHaveLength(1);
    expect(states.at(-1)?.state).toBe('stopped');
    client = null;
  });

  it('rotate() switches to a fresh connection without a gap', async () => {
    server = await startWsServer();
    let tick = 0;
    server.wss.on('connection', (s) => {
      const timer = setInterval(() => s.send(String(tick++)), 10);
      s.on('close', () => clearInterval(timer));
    });
    const { ws, messages, states } = connect(server.url, { onOpen: ({ send }) => void send('sub') });
    await waitFor(() => messages.length > 5, 3_000, 'data on first connection');
    ws.rotate();
    await waitFor(() => server!.received.length === 2, 3_000, 'subscribe on new connection');
    await waitFor(() => server!.connections[0]!.readyState === 3, 3_000, 'old connection closed');
    const before = messages.length;
    await waitFor(() => messages.length > before + 5, 3_000, 'data on new connection');
    expect(server.received.map((r) => r.conn)).toEqual([0, 1]);
    expect(states.map((s) => s.state)).not.toContain('reconnecting');
    expect(states.at(-1)).toMatchObject({ state: 'open', reason: 'rotated' });
    expect(ws.health().reconnects).toBe(0);
  });
});
