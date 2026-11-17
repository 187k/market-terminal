import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionUser } from '@mip/core';
import type { SessionStore } from './sessions.js';

export const SESSION_COOKIE = 'mip_session';

export interface AuthConfig {
  username: string;
  password: string;
  ttlSeconds: number;
  cookieSecure: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
  }
}

const loginBody = z.object({ username: z.string().min(1), password: z.string().min(1) });

/** Constant-time comparison that does not leak the length of the expected value. */
function safeEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Slows down password guessing: N failures per IP within the window block further attempts. */
export class LoginThrottle {
  readonly #failures = new Map<string, { count: number; firstAt: number }>();
  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 5 * 60_000,
  ) {}

  blocked(ip: string, now = Date.now()): boolean {
    const f = this.#failures.get(ip);
    if (!f) return false;
    if (now - f.firstAt > this.windowMs) {
      this.#failures.delete(ip);
      return false;
    }
    return f.count >= this.maxFailures;
  }

  fail(ip: string, now = Date.now()): void {
    const f = this.#failures.get(ip);
    if (!f || now - f.firstAt > this.windowMs) this.#failures.set(ip, { count: 1, firstAt: now });
    else f.count++;
  }

  reset(ip: string): void {
    this.#failures.delete(ip);
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Login required.' });
  }
}

export function registerAuth(app: FastifyInstance, config: AuthConfig, sessions: SessionStore): void {
  const throttle = new LoginThrottle();
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const username = await sessions.get(unsigned.value);
    if (username) {
      request.user = { username };
      request.sessionId = unsigned.value;
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'Username and password are required.' });
    }
    if (throttle.blocked(request.ip)) {
      return reply
        .code(429)
        .send({ error: 'too_many_attempts', message: 'Too many failed logins. Try again in a few minutes.' });
    }
    const userOk = safeEqual(parsed.data.username, config.username);
    const passOk = safeEqual(parsed.data.password, config.password);
    if (!(userOk && passOk)) {
      throttle.fail(request.ip);
      request.log.warn({ ip: request.ip }, 'failed login attempt');
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Wrong username or password.' });
    }
    throttle.reset(request.ip);
    const id = await sessions.create(config.username, config.ttlSeconds);
    reply.setCookie(SESSION_COOKIE, id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      signed: true,
      maxAge: config.ttlSeconds,
    });
    request.log.info({ username: config.username }, 'login');
    const user: SessionUser = { username: config.username };
    return user;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.sessionId) await sessions.destroy(request.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => request.user);
}
