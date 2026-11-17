import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@mip/core';
import { TelegramNotifier, telegramConfigFromEnv } from './notifier.js';

const logger = createLogger({ service: 'test', level: 'silent' });

interface Call {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

/** A minimal Telegram Bot API stand-in: answers per method via `reply`. */
async function fakeTelegram(reply: (call: Call, n: number) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const [, bot, method] = (req.url ?? '').split('/');
    const call = { token: (bot ?? '').slice(3), method: method ?? '', body: raw ? JSON.parse(raw) : {} };
    calls.push(call);
    const r = reply(call, calls.length);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(() => r(null))),
  };
}

let close: (() => Promise<unknown>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const config = { chatId: '-1001234567890', bots: { 'fair-price': { token: '123:abc', topicId: 7 } } };

describe('TelegramNotifier', () => {
  it('sends HTML into the scanner topic and edits it later', async () => {
    const tg = await fakeTelegram((c) =>
      c.method === 'sendMessage'
        ? { body: { ok: true, result: { message_id: 42, chat: { id: -1, type: 'supergroup' }, date: 0 } } }
        : { body: { ok: true, result: true } },
    );
    close = tg.close;
    const n = new TelegramNotifier(config, { logger, apiRoot: tg.apiRoot });
    expect(await n.send('fair-price', '<b>LONG</b>')).toBe(42);
    await n.edit('fair-price', 42, '<b>LONG</b> updated');
    expect(tg.calls.map((c) => c.method)).toEqual(['sendMessage', 'editMessageText']);
    expect(tg.calls[0]).toMatchObject({
      token: '123:abc',
      body: { chat_id: '-1001234567890', text: '<b>LONG</b>', parse_mode: 'HTML', message_thread_id: 7 },
    });
    expect(tg.calls[1]!.body).toMatchObject({ message_id: 42, text: '<b>LONG</b> updated' });
  });

  it('waits for retry_after on HTTP 429 and retries', async () => {
    const tg = await fakeTelegram((_c, n) =>
      n === 1
        ? {
            status: 429,
            body: {
              ok: false,
              error_code: 429,
              description: 'Too Many Requests: retry after 1',
              parameters: { retry_after: 1 },
            },
          }
        : { body: { ok: true, result: { message_id: 5, chat: { id: -1, type: 'supergroup' }, date: 0 } } },
    );
    close = tg.close;
    const n = new TelegramNotifier(config, { logger, apiRoot: tg.apiRoot });
    const started = Date.now();
    expect(await n.send('fair-price', 'x')).toBe(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900); // retry_after + 1 s margin
    expect(tg.calls).toHaveLength(2);
  });

  it('retries a Telegram 5xx and then delivers', async () => {
    const tg = await fakeTelegram((_c, n) =>
      n === 1
        ? { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } }
        : { body: { ok: true, result: { message_id: 9, chat: { id: -1, type: 'supergroup' }, date: 0 } } },
    );
    close = tg.close;
    const n = new TelegramNotifier(config, { logger, apiRoot: tg.apiRoot, retryBaseMs: 10 });
    expect(await n.send('fair-price', 'x')).toBe(9);
    expect(tg.calls).toHaveLength(2);
    expect(n.status('fair-price').state).toBe('ok');
  });

  it('gives up after the retry limit on a lasting 5xx', async () => {
    const tg = await fakeTelegram(() => ({
      status: 502,
      body: { ok: false, error_code: 502, description: 'Bad Gateway' },
    }));
    close = tg.close;
    const n = new TelegramNotifier(config, { logger, apiRoot: tg.apiRoot, retryBaseMs: 1, maxRetries: 2 });
    await expect(n.send('fair-price', 'x')).rejects.toThrow('Bad Gateway');
    expect(tg.calls).toHaveLength(3);
  });

  it('does not resend a message whose request timed out (it may have been posted)', async () => {
    const server = http.createServer(() => undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let requests = 0;
    server.on('request', () => requests++);
    close = () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r(null)));
    };
    const { port } = server.address() as AddressInfo;
    const n = new TelegramNotifier(config, {
      logger,
      apiRoot: `http://127.0.0.1:${port}`,
      timeoutSeconds: 1,
      retryBaseMs: 1,
    });
    await expect(n.send('fair-price', 'x')).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it('treats "message is not modified" as success', async () => {
    const tg = await fakeTelegram(() => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
    }));
    close = tg.close;
    const n = new TelegramNotifier(config, { logger, apiRoot: tg.apiRoot });
    await expect(n.edit('fair-price', 1, 'same')).resolves.toBeUndefined();
  });

  it('disables a bot whose token Telegram rejects', async () => {
    const tg = await fakeTelegram(() => ({
      status: 401,
      body: { ok: false, error_code: 401, description: 'Unauthorized' },
    }));
    close = tg.close;
    const n = new TelegramNotifier(config, { logger, apiRoot: tg.apiRoot });
    await n.verify();
    expect(n.status('fair-price')).toEqual({
      state: 'error',
      detail: 'bot token rejected by Telegram (Unauthorized)',
    });
    await expect(n.send('fair-price', 'x')).rejects.toThrow('bot token rejected');
  });

  it('gives up on a getMe that never answers instead of blocking startup', async () => {
    const server = http.createServer(() => undefined); // accepts the request, never replies
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    close = () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r(null)));
    };
    const { port } = server.address() as AddressInfo;
    const n = new TelegramNotifier(config, {
      logger,
      apiRoot: `http://127.0.0.1:${port}`,
      timeoutSeconds: 1,
    });
    const started = Date.now();
    await n.verify();
    expect(Date.now() - started).toBeLessThan(5_000);
    // A timeout is not a verdict on the token: the bot stays usable.
    expect(n.status('fair-price')).toEqual({ state: 'ok', detail: null });
  });

  it('explains what is missing when not configured', () => {
    const n = new TelegramNotifier({ bots: {} }, { logger });
    expect(n.unavailableReason('fair-price')).toBe('TELEGRAM_CHAT_ID is not set');
    const m = new TelegramNotifier({ chatId: '1', bots: {} }, { logger });
    expect(m.status('funding')).toEqual({
      state: 'disabled',
      detail: 'TELEGRAM_FUNDING_BOT_TOKEN is not set',
    });
  });

  it('reads bots and topics from the environment', () => {
    const cfg = telegramConfigFromEnv({
      TELEGRAM_CHAT_ID: '-100',
      TELEGRAM_SPREAD_BOT_TOKEN: 't1',
      TELEGRAM_SPREAD_TOPIC_ID: 12,
      TELEGRAM_TWAP_BOT_TOKEN: 't2',
    } as never);
    expect(cfg).toEqual({
      chatId: '-100',
      bots: { spread: { token: 't1', topicId: 12 }, twap: { token: 't2' } },
    });
  });
});
