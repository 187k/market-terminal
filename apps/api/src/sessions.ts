import { randomBytes } from 'node:crypto';
import { KEYS, type Redis } from '@mip/bus';

export interface SessionStore {
  create(username: string, ttlSeconds: number): Promise<string>;
  get(id: string): Promise<string | null>;
  destroy(id: string): Promise<void>;
}

const newId = () => randomBytes(32).toString('base64url');

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(username: string, ttlSeconds: number): Promise<string> {
    const id = newId();
    await this.redis.set(KEYS.session(id), username, 'EX', Math.ceil(ttlSeconds));
    return id;
  }

  async get(id: string): Promise<string | null> {
    return this.redis.get(KEYS.session(id));
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(KEYS.session(id));
  }
}

/** For tests and local experiments without Redis. */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, { username: string; expiresAt: number }>();

  async create(username: string, ttlSeconds: number): Promise<string> {
    const id = newId();
    this.#sessions.set(id, { username, expiresAt: Date.now() + ttlSeconds * 1000 });
    return id;
  }

  async get(id: string): Promise<string | null> {
    const s = this.#sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.#sessions.delete(id);
      return null;
    }
    return s.username;
  }

  async destroy(id: string): Promise<void> {
    this.#sessions.delete(id);
  }
}
