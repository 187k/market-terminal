import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WS_CLOSE_UNAUTHORIZED, type Logger, type RealtimeServerMessage } from '@mip/core';
import type { SessionStore } from './sessions.js';

/** How a topic's payload is produced: the same read the matching REST route does. */
export interface TopicLoader {
  load(): Promise<unknown>;
  intervalMs: number;
}

/** Returns null for a topic that does not exist (unknown name, invalid exchange or asset code). */
export type TopicResolver = (topic: string) => TopicLoader | null;

export interface RealtimeClient {
  send(message: string): void;
}

interface TopicState {
  loader: TopicLoader;
  subscribers: Set<RealtimeClient>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Last message sent, so unchanged payloads are not pushed again and new subscribers get it at once. */
  last: string | null;
  failing: boolean;
  stopped: boolean;
}

/**
 * Fan-out of periodic reads to WebSocket clients. Each topic is read once per interval no
 * matter how many clients follow it, only while someone does, and a payload is pushed only
 * when it differs from the previous one. Reads never overlap: the next starts after the last.
 */
export class RealtimeHub {
  readonly #resolve: TopicResolver;
  readonly #log: Logger;
  readonly #topics = new Map<string, TopicState>();

  constructor(resolve: TopicResolver, logger: Logger) {
    this.#resolve = resolve;
    this.#log = logger.child({ component: 'realtime' });
  }

  /** Number of topics currently being read (for tests and diagnostics). */
  get activeTopics(): number {
    return this.#topics.size;
  }

  subscribe(client: RealtimeClient, topic: string): boolean {
    let state = this.#topics.get(topic);
    if (!state) {
      const loader = this.#resolve(topic);
      if (!loader) return false;
      state = { loader, subscribers: new Set(), timer: null, last: null, failing: false, stopped: false };
      this.#topics.set(topic, state);
      state.subscribers.add(client);
      void this.#run(topic, state);
      return true;
    }
    state.subscribers.add(client);
    if (state.last) client.send(state.last);
    return true;
  }

  unsubscribe(client: RealtimeClient, topic: string): void {
    const state = this.#topics.get(topic);
    if (!state) return;
    state.subscribers.delete(client);
    if (state.subscribers.size === 0) this.#stop(topic, state);
  }

  remove(client: RealtimeClient): void {
    for (const [topic, state] of this.#topics) {
      state.subscribers.delete(client);
      if (state.subscribers.size === 0) this.#stop(topic, state);
    }
  }

  close(): void {
    for (const [topic, state] of this.#topics) this.#stop(topic, state);
  }

  #stop(topic: string, state: TopicState): void {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    this.#topics.delete(topic);
  }

  async #run(topic: string, state: TopicState): Promise<void> {
    if (state.stopped) return;
    try {
      const data = await state.loader.load();
      if (state.stopped) return;
      const message = JSON.stringify({ type: 'data', topic, data } satisfies RealtimeServerMessage);
      if (state.failing) this.#log.info({ topic }, 'realtime topic recovered');
      state.failing = false;
      if (message !== state.last) {
        state.last = message;
        for (const c of state.subscribers) c.send(message);
      }
    } catch (err) {
      if (state.stopped) return;
      // Report an outage once, not on every retry.
      if (!state.failing) {
        state.failing = true;
        this.#log.warn({ topic, err: (err as Error).message }, 'realtime topic read failed');
        const message = JSON.stringify({
          type: 'error',
          topic,
          message: 'The server could not read this data; retrying.',
        } satisfies RealtimeServerMessage);
        for (const c of state.subscribers) c.send(message);
      }
    }
    if (!state.stopped) state.timer = setTimeout(() => void this.#run(topic, state), state.loader.intervalMs);
  }
}

const clientMessage = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  topics: z.array(z.string().min(1).max(64)).max(16),
});

/** Topics one connection may follow at once; the dashboard needs at most six. */
export const MAX_TOPICS_PER_CLIENT = 16;
/** A client that has not answered two pings in a row is gone (sleeping laptop, dropped network). */
const PING_INTERVAL_MS = 30_000;
/** Sessions can be ended elsewhere (logout in another tab, expiry); re-check this often. */
const SESSION_CHECK_MS = 60_000;
/** Skip pushes to a client that cannot keep up instead of buffering without limit. */
const MAX_BUFFERED_BYTES = 1_000_000;

/** Cross-site WebSocket hijacking guard: a browser Origin must name the host it connects to. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // non-browser clients send no Origin
  if (!host) return false;
  try {
    // Compare hostnames only: nginx forwards `$host`, which drops the port.
    return new URL(origin).hostname === host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
}

/**
 * `/ws`: dashboard realtime updates. Requires the session cookie (checked when the socket opens
 * and every minute after); closes with 4401 when the session is missing or ended, so the
 * browser can tell "log in again" from a network problem.
 */
export function registerRealtime(
  app: FastifyInstance,
  hub: RealtimeHub,
  sessions: SessionStore,
  logger: Logger,
): void {
  const log = logger.child({ component: 'realtime' });

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    if (!originAllowed(request.headers.origin, request.headers.host)) {
      socket.close(4403, 'Origin not allowed');
      return;
    }
    const sessionId = request.sessionId;
    if (!request.user || !sessionId) {
      socket.close(WS_CLOSE_UNAUTHORIZED, 'Login required');
      return;
    }

    const topics = new Set<string>();
    const client: RealtimeClient = {
      send(message) {
        if (socket.readyState === socket.OPEN && socket.bufferedAmount < MAX_BUFFERED_BYTES)
          socket.send(message);
      },
    };
    const sendJson = (m: RealtimeServerMessage) => client.send(JSON.stringify(m));
    sendJson({ type: 'hello', serverTime: Date.now() });

    let alive = true;
    socket.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, PING_INTERVAL_MS);
    const sessionCheck = setInterval(() => {
      sessions
        .get(sessionId)
        .then((user) => {
          if (!user) socket.close(WS_CLOSE_UNAUTHORIZED, 'Session ended');
        })
        .catch(() => undefined); // Redis hiccup: keep the socket, check again next time
    }, SESSION_CHECK_MS);

    socket.on('message', (raw, isBinary) => {
      let parsed: z.infer<typeof clientMessage>;
      try {
        if (isBinary) throw new Error('binary');
        parsed = clientMessage.parse(JSON.parse(String(raw)));
      } catch {
        sendJson({ type: 'error', topic: null, message: 'Expected {"type":"subscribe","topics":[...]}' });
        return;
      }
      for (const topic of parsed.topics) {
        if (parsed.type === 'unsubscribe') {
          if (topics.delete(topic)) hub.unsubscribe(client, topic);
          continue;
        }
        if (topics.has(topic)) continue;
        if (topics.size >= MAX_TOPICS_PER_CLIENT) {
          sendJson({
            type: 'error',
            topic,
            message: `At most ${MAX_TOPICS_PER_CLIENT} topics per connection`,
          });
          continue;
        }
        if (hub.subscribe(client, topic)) topics.add(topic);
        else sendJson({ type: 'error', topic, message: `Unknown topic: ${topic}` });
      }
    });

    socket.on('close', () => {
      clearInterval(ping);
      clearInterval(sessionCheck);
      hub.remove(client);
    });
    socket.on('error', (err) => log.debug({ err: err.message }, 'websocket error'));
  });
}
