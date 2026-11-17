import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger, sleep } from '@mip/core';

export const silentLogger = createLogger({ service: 'test', level: 'silent' });

export const FAST_BACKOFF = { baseMs: 20, maxMs: 100, jitter: 0 };

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 3_000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms: ${label}`);
    await sleep(10);
  }
}

export interface Received {
  conn: number;
  text: string;
}

export interface TestWsServer {
  url: string;
  wss: WebSocketServer;
  /** Every server-side socket in connection order (closed ones included). */
  connections: WebSocket[];
  received: Received[];
  close(): Promise<void>;
}

export async function startWsServer(
  options: { verifyClient?: (info: unknown, cb: (ok: boolean, code?: number) => void) => void } = {},
): Promise<TestWsServer> {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    ...(options.verifyClient ? { verifyClient: options.verifyClient } : {}),
  });
  await once(wss, 'listening');
  const { port } = wss.address() as AddressInfo;
  const connections: WebSocket[] = [];
  const received: Received[] = [];
  wss.on('connection', (ws) => {
    const conn = connections.push(ws) - 1;
    ws.on('message', (data) => received.push({ conn, text: data.toString() }));
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    wss,
    connections,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

export interface TestHttpServer {
  baseUrl: string;
  hits: { method: string; path: string; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

export async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void,
): Promise<TestHttpServer> {
  const hits: TestHttpServer['hits'] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers });
    handler(req, res, hits.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
