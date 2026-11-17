import { EventEmitter } from 'node:events';
import type { ConnectionHealth, Logger } from '@mip/core';
import { RateLimiter, type WindowLimit } from './rate-limiter.js';
import {
  ManagedWebSocket,
  type ManagedWebSocketOptions,
  type OpenContext,
  type WsMessage,
  type WsStateChange,
} from './ws-client.js';

/** Exchange-specific encoding of subscribe / unsubscribe requests. */
export interface SubscriptionProtocol {
  /** Returns the messages to send; split them so each respects the exchange's per-request limits. */
  subscribe(topics: readonly string[]): string[];
  unsubscribe(topics: readonly string[]): string[];
}

export interface SubscriptionManagerOptions {
  /** Prefix for connection names, e.g. "bybit/linear" -> "bybit/linear#0". */
  name: string;
  url: string | ((shard: number) => string);
  protocol: SubscriptionProtocol;
  maxTopicsPerConnection: number;
  maxConnections: number;
  /** Pacing of subscribe/unsubscribe messages per connection (e.g. Binance: 10 incoming messages/s). */
  sendRate?: WindowLimit;
  socket?: Omit<ManagedWebSocketOptions, 'name' | 'url' | 'logger' | 'onOpen'>;
  logger: Logger;
}

interface Shard {
  index: number;
  socket: ManagedWebSocket;
  topics: Set<string>;
  limiter: RateLimiter | null;
  ctx: OpenContext | null;
}

type Events = { message: [WsMessage]; state: [WsStateChange] };

/**
 * Spreads topics across as few connections as the exchange limits allow and
 * re-subscribes each connection's topics, paced, whenever it (re)opens.
 */
export class SubscriptionManager extends EventEmitter<Events> {
  readonly name: string;
  readonly #opts: SubscriptionManagerOptions;
  readonly #log: Logger;
  #shards: Shard[] = [];
  #nextIndex = 0;
  #running = false;

  constructor(options: SubscriptionManagerOptions) {
    super();
    if (options.maxTopicsPerConnection < 1 || options.maxConnections < 1) {
      throw new Error(`${options.name}: maxTopicsPerConnection and maxConnections must be >= 1`);
    }
    this.name = options.name;
    this.#opts = options;
    this.#log = options.logger.child({ component: 'subscriptions', stream: options.name });
  }

  get capacity(): number {
    return this.#opts.maxTopicsPerConnection * this.#opts.maxConnections;
  }

  topics(): string[] {
    return this.#shards.flatMap((s) => [...s.topics]);
  }

  /** Adds topics; returns those that did not fit within the connection limits. */
  add(topics: readonly string[]): { added: string[]; rejected: string[] } {
    const existing = new Set(this.topics());
    const added: string[] = [];
    const rejected: string[] = [];
    const perShard = new Map<Shard, string[]>();
    const created = new Set<Shard>();

    for (const topic of new Set(topics)) {
      if (existing.has(topic)) continue;
      let shard = this.#shards.find((s) => s.topics.size < this.#opts.maxTopicsPerConnection);
      if (!shard) {
        if (this.#shards.length >= this.#opts.maxConnections) {
          rejected.push(topic);
          continue;
        }
        shard = this.#createShard();
        created.add(shard);
      }
      shard.topics.add(topic);
      shard.socket.topics = shard.topics.size;
      existing.add(topic);
      added.push(topic);
      perShard.set(shard, [...(perShard.get(shard) ?? []), topic]);
    }

    if (rejected.length > 0) {
      this.#log.error(
        { rejected: rejected.length, capacity: this.capacity },
        'topics exceed connection limits',
      );
    }
    if (this.#running) {
      for (const [shard, list] of perShard) {
        if (created.has(shard)) shard.socket.start();
        else if (shard.ctx) void this.#sendPaced(shard, this.#opts.protocol.subscribe(list), shard.ctx);
      }
    }
    return { added, rejected };
  }

  remove(topics: readonly string[]): void {
    const wanted = new Set(topics);
    for (const shard of [...this.#shards]) {
      const list = [...shard.topics].filter((t) => wanted.has(t));
      if (list.length === 0) continue;
      for (const t of list) shard.topics.delete(t);
      shard.socket.topics = shard.topics.size;
      if (shard.topics.size === 0) {
        this.#shards = this.#shards.filter((s) => s !== shard);
        void shard.socket.stop('no topics left');
        shard.limiter?.close();
      } else if (shard.ctx) {
        void this.#sendPaced(shard, this.#opts.protocol.unsubscribe(list), shard.ctx);
      }
    }
  }

  start(): void {
    this.#running = true;
    for (const shard of this.#shards) shard.socket.start();
  }

  async stop(): Promise<void> {
    this.#running = false;
    await Promise.all(this.#shards.map((s) => s.socket.stop()));
    for (const s of this.#shards) s.limiter?.close();
  }

  health(): ConnectionHealth[] {
    return this.#shards.map((s) => s.socket.health());
  }

  /** Test / ops hook: forces a planned rotation on every connection. */
  rotateAll(): void {
    for (const s of this.#shards) s.socket.rotate();
  }

  /** Test / ops hook: cuts every connection as a network failure would. */
  dropAll(reason?: string): void {
    for (const s of this.#shards) s.socket.drop(reason);
  }

  #createShard(): Shard {
    const index = this.#nextIndex++;
    const name = `${this.name}#${index}`;
    const url = this.#opts.url;
    const limiter = this.#opts.sendRate
      ? new RateLimiter({ name: `${name}/send`, windows: [this.#opts.sendRate], headroom: 1 })
      : null;
    const shard: Shard = {
      index,
      topics: new Set(),
      limiter,
      ctx: null,
      socket: new ManagedWebSocket({
        ...this.#opts.socket,
        name,
        url: typeof url === 'function' ? () => url(index) : url,
        logger: this.#opts.logger,
        onOpen: (ctx) => {
          shard.ctx = ctx;
          ctx.signal.addEventListener('abort', () => {
            if (shard.ctx === ctx) shard.ctx = null;
          });
          return this.#sendPaced(shard, this.#opts.protocol.subscribe([...shard.topics]), ctx);
        },
      }),
    };
    shard.socket.on('message', (m) => this.emit('message', m));
    shard.socket.on('state', (s) => this.emit('state', s));
    this.#shards.push(shard);
    return shard;
  }

  async #sendPaced(shard: Shard, messages: string[], ctx: OpenContext): Promise<void> {
    for (const msg of messages) {
      if (ctx.signal.aborted) return;
      if (shard.limiter) {
        try {
          await shard.limiter.acquire(1, { signal: ctx.signal });
        } catch {
          return; // socket closed or manager stopped; the next open re-subscribes everything
        }
      }
      if (!ctx.send(msg)) return;
    }
  }
}

/**
 * Groups items into as few messages as possible without exceeding `maxItems` per
 * message or `maxBytes` per encoded message (e.g. Bybit: 21,000 characters).
 */
export function batchMessages(
  items: readonly string[],
  limits: { maxItems: number; maxBytes?: number },
  encode: (batch: string[]) => string,
): string[] {
  const out: string[] = [];
  let batch: string[] = [];
  for (const item of items) {
    const candidate = [...batch, item];
    const tooMany = candidate.length > limits.maxItems;
    const tooBig = limits.maxBytes !== undefined && Buffer.byteLength(encode(candidate)) > limits.maxBytes;
    if (batch.length > 0 && (tooMany || tooBig)) {
      out.push(encode(batch));
      batch = [item];
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) out.push(encode(batch));
  return out;
}
