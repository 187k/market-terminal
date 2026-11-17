import { readFileSync } from 'node:fs';
import type { ExchangeId, InstrumentInfo, MarketUpdate } from '@mip/core';
import type { MarketSink } from '../base/connector.js';
import { json, startHttpServer, startWsServer, type TestHttpServer, type TestWsServer } from './servers.js';

/** Reads a recorded fixture next to the calling test: loadFixture(import.meta.url, 'rest-tickers'). */
export function loadFixture<T = any>(testUrl: string, name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, testUrl), 'utf8')) as T;
}

export interface ReplayExchange {
  restUrl: string;
  wsUrl: string;
  http: TestHttpServer;
  ws: TestWsServer;
  close(): Promise<void>;
}

/**
 * A local stand-in for an exchange: serves recorded REST bodies by path and lets the test
 * answer WebSocket messages (e.g. replay recorded pushes after a subscribe request).
 */
export async function startReplayExchange(options: {
  rest: Record<string, unknown | ((query: URLSearchParams) => unknown)>;
  onMessage: (text: string, send: (msg: unknown) => void) => void;
}): Promise<ReplayExchange> {
  const http = await startHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = options.rest[url.pathname];
    if (body === undefined) return json(res, 404, { error: `no fixture for ${url.pathname}` });
    json(
      res,
      200,
      typeof body === 'function' ? (body as (q: URLSearchParams) => unknown)(url.searchParams) : body,
    );
  });
  const ws = await startWsServer();
  ws.wss.on('connection', (socket) => {
    socket.on('message', (data) =>
      options.onMessage(data.toString(), (msg) =>
        socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
      ),
    );
  });
  return {
    restUrl: http.baseUrl,
    wsUrl: ws.url,
    http,
    ws,
    close: async () => {
      await ws.close();
      await http.close();
    },
  };
}

/** Sink that records everything a connector produces. */
export function collectingSink() {
  const updates: MarketUpdate[] = [];
  const instruments: InstrumentInfo[][] = [];
  const sink: MarketSink = {
    market: (_ex: ExchangeId, u) => updates.push(u),
    instruments: (_ex: ExchangeId, list) => instruments.push(list),
  };
  return { sink, updates, instruments };
}
