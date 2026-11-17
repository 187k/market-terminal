import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import {
  backoffDelay,
  systemNow,
  type BackoffOptions,
  type ConnectionHealth,
  type ConnectionState,
  type Logger,
  type Now,
} from '@mip/core';

export interface WsStateChange {
  connection: string;
  state: ConnectionState;
  reason: string | null;
  at: number;
}

export interface WsMessage {
  connection: string;
  text: string;
  /** Local receive time (ms). Exchange timestamps are parsed by each connector. */
  receivedAt: number;
}

export interface OpenContext {
  /** Sends on the socket that just opened; returns false once that socket is gone. */
  send: (data: string) => boolean;
  /** True for every open after the first one (reconnects and rotations). */
  isReconnect: boolean;
  /** Aborted when this particular socket closes, so (re)subscribe loops can stop early. */
  signal: AbortSignal;
}

export interface HeartbeatOptions {
  intervalMs: number;
  /** Application-level ping payload. Omit to send a WebSocket protocol ping frame. */
  message?: () => string;
}

export interface ManagedWebSocketOptions {
  name: string;
  url: string | (() => string);
  logger: Logger;
  heartbeat?: HeartbeatOptions;
  /** Replies to application-level pings from the server (BingX "Ping" -> "Pong"). Return null for normal messages. */
  serverPing?: (text: string) => string | null;
  /** Converts a raw frame to text, e.g. gunzip. Defaults to UTF-8. */
  decode?: (data: Buffer, isBinary: boolean) => string;
  /** Reconnect if nothing at all (data, pong, ping) arrives for this long. Default 30 s. */
  staleAfterMs?: number;
  connectTimeoutMs?: number;
  backoff?: BackoffOptions;
  /** Reset the backoff after the connection has stayed open this long. Default 30 s. */
  stableAfterMs?: number;
  /** Replace the connection before the exchange force-closes it (Binance: 24 h). */
  maxLifetimeMs?: number;
  headers?: Record<string, string>;
  /** Called on every open (first connect, reconnect, rotation); use it to (re)subscribe. */
  onOpen?: (ctx: OpenContext) => void | Promise<void>;
  now?: Now;
}

type Events = { state: [WsStateChange]; message: [WsMessage] };

const ROTATION_RETRY_MS = 60_000;

export const gunzipDecoder = (data: Buffer, isBinary: boolean): string =>
  isBinary ? gunzipSync(data).toString('utf8') : data.toString('utf8');

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * A WebSocket that keeps itself alive: heartbeats, stale-data detection, reconnect with
 * jittered exponential backoff, and planned rotation with overlap so no data is lost.
 */
export class ManagedWebSocket extends EventEmitter<Events> {
  readonly name: string;
  /** Number of topics on this connection; maintained by the owner for health reporting. */
  topics = 0;

  readonly #opts: ManagedWebSocketOptions;
  readonly #log: Logger;
  readonly #now: Now;
  readonly #staleAfterMs: number;
  readonly #stableAfterMs: number;
  readonly #backoff: BackoffOptions;

  #socket: WebSocket | null = null;
  #socketAbort: AbortController | null = null;
  #candidate: WebSocket | null = null;
  readonly #retired = new WeakSet<WebSocket>();
  #state: ConnectionState = 'idle';
  #attempt = 0;
  #everOpened = false;
  #stopping = false;
  #closeReason: string | null = null;

  #reconnectTimer: NodeJS.Timeout | null = null;
  #rotationRetryTimer: NodeJS.Timeout | null = null;
  #socketTimers: NodeJS.Timeout[] = [];

  #connectedAt: number | null = null;
  #lastMessageAt: number | null = null;
  #messages = 0;
  #reconnects = 0;
  #lastError: string | null = null;
  #lastReason: string | null = null;
  #lastStateChangeAt: number;

  constructor(options: ManagedWebSocketOptions) {
    super();
    this.name = options.name;
    this.#opts = options;
    this.#now = options.now ?? systemNow;
    this.#log = options.logger.child({ component: 'ws', connection: options.name });
    this.#staleAfterMs = options.staleAfterMs ?? 30_000;
    this.#stableAfterMs = options.stableAfterMs ?? 30_000;
    this.#backoff = options.backoff ?? { baseMs: 500, maxMs: 30_000, jitter: 0.5 };
    this.#lastStateChangeAt = this.#now();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  start(): void {
    if (this.#state !== 'idle' && this.#state !== 'stopped') return;
    this.#stopping = false;
    this.#attempt = 0;
    this.#connect();
  }

  async stop(reason = 'stopped by client'): Promise<void> {
    this.#stopping = true;
    this.#clearTimer('reconnect');
    this.#clearTimer('rotation');
    this.#clearSocketTimers();
    if (this.#candidate) {
      this.#retired.add(this.#candidate);
      this.#candidate.terminate();
      this.#candidate = null;
    }
    const ws = this.#socket;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => ws.terminate(), 2_000);
        ws.once('close', () => {
          clearTimeout(force);
          resolve();
        });
        ws.close(1000, 'client stop');
      });
    }
    this.#socket = null;
    this.#socketAbort?.abort();
    this.#connectedAt = null;
    this.#setState('stopped', reason);
  }

  /** Sends on the current socket. Returns false if it is not open. */
  send(data: string): boolean {
    return this.#sendOn(this.#socket, data);
  }

  /**
   * Kills the current socket without a close handshake, exactly like a network failure, so the
   * normal reconnect path runs. Used by live recovery tests and for manual troubleshooting.
   */
  drop(reason = 'dropped on request'): void {
    if (!this.#socket || this.#stopping) return;
    this.#closeReason = reason;
    this.#socket.terminate();
  }

  /** Opens a replacement connection and switches over once it is open and subscribed. */
  rotate(): void {
    if (this.#stopping || this.#state !== 'open' || this.#candidate) return;
    this.#log.info('rotating connection');
    const ws = this.#createSocket();
    this.#candidate = ws;
    this.#bind(ws);
  }

  health(): ConnectionHealth {
    const url = typeof this.#opts.url === 'function' ? this.#opts.url() : this.#opts.url;
    return {
      name: this.name,
      url: url.length > 200 ? `${url.slice(0, 197)}...` : url,
      state: this.#state,
      topics: this.topics,
      connectedAt: this.#connectedAt,
      lastMessageAt: this.#lastMessageAt,
      messages: this.#messages,
      reconnects: this.#reconnects,
      lastError: this.#lastError,
      lastReason: this.#lastReason,
      lastStateChangeAt: this.#lastStateChangeAt,
    };
  }

  // ---------------------------------------------------------------------------

  #connect(): void {
    this.#setState('connecting', this.#attempt > 0 ? `attempt ${this.#attempt + 1}` : null);
    const ws = this.#createSocket();
    this.#socket = ws;
    this.#bind(ws);
  }

  #createSocket(): WebSocket {
    const url = typeof this.#opts.url === 'function' ? this.#opts.url() : this.#opts.url;
    return new WebSocket(url, {
      handshakeTimeout: this.#opts.connectTimeoutMs ?? 10_000,
      perMessageDeflate: false,
      ...(this.#opts.headers ? { headers: this.#opts.headers } : {}),
    });
  }

  #bind(ws: WebSocket): void {
    ws.on('open', () => this.#onOpen(ws));
    ws.on('message', (data, isBinary) => this.#onMessage(ws, data, isBinary));
    ws.on('pong', () => this.#touch(ws));
    ws.on('ping', () => this.#touch(ws));
    ws.on('error', (err) => {
      if (this.#retired.has(ws)) return;
      this.#lastError = err.message;
      this.#log.warn({ err: err.message }, 'websocket error');
    });
    ws.on('close', (code, reason) => this.#onClose(ws, code, reason.toString()));
  }

  #onOpen(ws: WebSocket): void {
    if (this.#stopping || this.#retired.has(ws)) {
      ws.terminate();
      return;
    }
    let reason: string | null = null;
    if (ws === this.#candidate) {
      // Rotation: promote the new socket, retire the old one.
      const old = this.#socket;
      this.#candidate = null;
      this.#clearSocketTimers();
      this.#socketAbort?.abort();
      this.#socket = ws;
      if (old) {
        this.#retired.add(old);
        old.close(1000, 'rotation');
        setTimeout(() => old.terminate(), 5_000).unref();
      }
      reason = 'rotated';
    } else if (ws !== this.#socket) {
      ws.terminate();
      return;
    }

    const now = this.#now();
    this.#connectedAt = now;
    this.#lastMessageAt = now;
    this.#socketAbort = new AbortController();
    this.#setState('open', reason);
    this.#startSocketTimers(ws);

    const ctx: OpenContext = {
      send: (data) => this.#sendOn(ws, data),
      isReconnect: this.#everOpened,
      signal: this.#socketAbort.signal,
    };
    this.#everOpened = true;
    if (this.#opts.onOpen) {
      try {
        Promise.resolve(this.#opts.onOpen(ctx)).catch((err: unknown) => {
          this.#log.error({ err }, 'onOpen handler failed');
        });
      } catch (err) {
        this.#log.error({ err }, 'onOpen handler failed');
      }
    }
  }

  #onMessage(ws: WebSocket, data: WebSocket.RawData, isBinary: boolean): void {
    const receivedAt = this.#now();
    if (ws === this.#socket) this.#lastMessageAt = receivedAt;
    let text: string;
    try {
      const buf = toBuffer(data);
      text = this.#opts.decode ? this.#opts.decode(buf, isBinary) : buf.toString('utf8');
    } catch (err) {
      this.#lastError = `decode failed: ${(err as Error).message}`;
      this.#log.warn({ err: (err as Error).message }, 'could not decode frame');
      return;
    }
    if (this.#opts.serverPing) {
      const reply = this.#opts.serverPing(text);
      if (reply !== null) {
        this.#sendOn(ws, reply);
        return;
      }
    }
    this.#messages++;
    try {
      this.emit('message', { connection: this.name, text, receivedAt });
    } catch (err) {
      this.#log.error({ err }, 'message handler threw');
    }
  }

  #onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.#retired.has(ws)) return;
    if (ws === this.#candidate) {
      this.#candidate = null;
      if (this.#stopping) return;
      this.#log.warn({ code, reason }, 'rotation candidate failed; keeping current connection');
      this.#clearTimer('rotation');
      this.#rotationRetryTimer = setTimeout(() => this.rotate(), ROTATION_RETRY_MS);
      return;
    }
    if (ws !== this.#socket) return;

    this.#clearSocketTimers();
    this.#socketAbort?.abort();
    this.#socket = null;
    this.#connectedAt = null;
    if (this.#candidate) {
      this.#retired.add(this.#candidate);
      this.#candidate.terminate();
      this.#candidate = null;
    }
    if (this.#stopping) return;

    const why = this.#closeReason ?? `closed (code ${code}${reason ? `: ${reason}` : ''})`;
    this.#closeReason = null;
    this.#scheduleReconnect(why);
  }

  #scheduleReconnect(why: string): void {
    const delay = backoffDelay(this.#attempt, this.#backoff);
    this.#attempt++;
    this.#reconnects++;
    this.#setState('reconnecting', `${why}; retry in ${delay} ms`);
    this.#clearTimer('reconnect');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#stopping) this.#connect();
    }, delay);
  }

  #startSocketTimers(ws: WebSocket): void {
    const hb = this.#opts.heartbeat;
    if (hb) {
      this.#socketTimers.push(
        setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (hb.message) this.#sendOn(ws, hb.message());
          else ws.ping();
        }, hb.intervalMs),
      );
    }
    const checkEvery = Math.max(50, Math.min(Math.floor(this.#staleAfterMs / 4), 5_000));
    this.#socketTimers.push(
      setInterval(() => {
        const silentFor = this.#now() - (this.#lastMessageAt ?? this.#now());
        if (silentFor > this.#staleAfterMs && ws === this.#socket) {
          this.#closeReason = `stale: no data for ${silentFor} ms`;
          this.#log.warn({ silentFor }, 'connection stale, reconnecting');
          ws.terminate();
        }
      }, checkEvery),
    );
    this.#socketTimers.push(
      setTimeout(() => {
        this.#attempt = 0;
      }, this.#stableAfterMs),
    );
    if (this.#opts.maxLifetimeMs) {
      this.#socketTimers.push(setTimeout(() => this.rotate(), this.#opts.maxLifetimeMs));
    }
  }

  #touch(ws: WebSocket): void {
    if (ws === this.#socket) this.#lastMessageAt = this.#now();
  }

  #sendOn(ws: WebSocket | null, data: string): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(data, (err) => {
      if (err) this.#log.warn({ err: err.message }, 'send failed');
    });
    return true;
  }

  #setState(state: ConnectionState, reason: string | null): void {
    if (this.#state === state && this.#lastReason === reason) return;
    this.#state = state;
    this.#lastReason = reason;
    this.#lastStateChangeAt = this.#now();
    const level = state === 'reconnecting' ? 'warn' : 'info';
    this.#log[level]({ state, reason }, `connection ${state}`);
    this.emit('state', { connection: this.name, state, reason, at: this.#lastStateChangeAt });
  }

  #clearTimer(which: 'reconnect' | 'rotation'): void {
    if (which === 'reconnect' && this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (which === 'rotation' && this.#rotationRetryTimer) {
      clearTimeout(this.#rotationRetryTimer);
      this.#rotationRetryTimer = null;
    }
  }

  #clearSocketTimers(): void {
    for (const t of this.#socketTimers) clearTimeout(t);
    this.#socketTimers = [];
  }
}
