import {
  WS_CLOSE_UNAUTHORIZED,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
  type RealtimeTopic,
} from '@mip/core/types';

export type ConnectionState = 'connecting' | 'open' | 'closed';

type TopicListener = (message: { data?: unknown; error?: string }) => void;

/**
 * One WebSocket per dashboard session. Components subscribe to topics; the connection
 * reconnects with backoff and re-subscribes, and reports its state so hooks can fall back to
 * REST polling while it is down. Close code 4401 means the session ended.
 */
export class RealtimeConnection {
  readonly #listeners = new Map<string, Set<TopicListener>>();
  readonly #stateListeners = new Set<(s: ConnectionState) => void>();
  readonly #onUnauthorized: () => void;
  #socket: WebSocket | null = null;
  #state: ConnectionState = 'closed';
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(onUnauthorized: () => void) {
    this.#onUnauthorized = onUnauthorized;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#socket?.close(1000, 'bye');
    this.#socket = null;
    this.#setState('closed');
  }

  onState(listener: (s: ConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  subscribe(topic: RealtimeTopic, listener: TopicListener): () => void {
    let set = this.#listeners.get(topic);
    if (!set) {
      set = new Set();
      this.#listeners.set(topic, set);
      this.#send({ type: 'subscribe', topics: [topic] });
    }
    set.add(listener);
    return () => {
      const s = this.#listeners.get(topic);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.#listeners.delete(topic);
        this.#send({ type: 'unsubscribe', topics: [topic] });
      }
    };
  }

  #setState(s: ConnectionState): void {
    if (s === this.#state) return;
    this.#state = s;
    for (const l of this.#stateListeners) l(s);
  }

  #send(m: RealtimeClientMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(m));
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#setState('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#setState('open');
      const topics = [...this.#listeners.keys()];
      if (topics.length) this.#send({ type: 'subscribe', topics });
    };

    socket.onmessage = (ev) => {
      let m: RealtimeServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as RealtimeServerMessage;
      } catch {
        return;
      }
      if (m.type === 'data') for (const l of this.#listeners.get(m.topic) ?? []) l({ data: m.data });
      else if (m.type === 'error' && m.topic)
        for (const l of this.#listeners.get(m.topic) ?? []) l({ error: m.message });
    };

    socket.onclose = (ev) => {
      if (this.#socket !== socket) return; // replaced or stopped
      this.#socket = null;
      this.#setState('closed');
      if (ev.code === WS_CLOSE_UNAUTHORIZED) {
        this.#stopped = true;
        this.#onUnauthorized();
        return;
      }
      if (this.#stopped) return;
      // 1 s, 2 s, 4 s … capped at 15 s, with jitter so tabs do not reconnect in lockstep.
      const delay = Math.min(15_000, 1_000 * 2 ** this.#attempt++) * (0.75 + Math.random() * 0.5);
      this.#timer = setTimeout(() => this.#connect(), delay);
    };
  }
}
