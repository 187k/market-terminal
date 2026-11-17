import { Api, GrammyError, HttpError } from 'grammy';
import { RateLimiter } from '@mip/connectors';
import type { EngineEnv, Logger, ScannerId } from '@mip/core';
import type { SignalNotifier } from './signals.js';

export interface BotConfig {
  token: string;
  /** Forum topic (message_thread_id); omit to post in the chat itself. */
  topicId?: number;
}

export interface TelegramConfig {
  chatId?: string;
  bots: Partial<Record<ScannerId, BotConfig>>;
}

/** Env variable prefix per scanner: TELEGRAM_<PREFIX>_BOT_TOKEN / _TOPIC_ID. */
export const TELEGRAM_ENV_PREFIX: Record<ScannerId, string> = {
  'fair-price': 'FAIR_PRICE',
  'open-interest': 'OPEN_INTEREST',
  funding: 'FUNDING',
  spread: 'SPREAD',
  twap: 'TWAP',
};

export function telegramConfigFromEnv(env: EngineEnv): TelegramConfig {
  const e = env as unknown as Record<string, string | number | undefined>;
  const bots: TelegramConfig['bots'] = {};
  for (const [scanner, prefix] of Object.entries(TELEGRAM_ENV_PREFIX) as [ScannerId, string][]) {
    const token = e[`TELEGRAM_${prefix}_BOT_TOKEN`];
    const topic = e[`TELEGRAM_${prefix}_TOPIC_ID`];
    if (typeof token === 'string' && token)
      bots[scanner] = { token, ...(typeof topic === 'number' ? { topicId: topic } : {}) };
  }
  return { ...(env.TELEGRAM_CHAT_ID ? { chatId: env.TELEGRAM_CHAT_ID } : {}), bots };
}

interface BotSlot {
  api: Api;
  topicId: number | undefined;
  limiter: RateLimiter;
  /** Set when Telegram rejected the bot or chat for good (bad token, chat not found). */
  fatal: string | null;
}

export interface TelegramNotifierOptions {
  logger: Logger;
  /** Bot API root; tests point this at a local fake. */
  apiRoot?: string;
  maxRetries?: number;
  /**
   * Per-request timeout. grammY's default is 500 s, so one stuck connection used to hold up
   * engine startup (`verify`) or a scanner's message queue for minutes.
   */
  timeoutSeconds?: number;
  /** First wait before retrying a Telegram 5xx or a failed connection; doubles per attempt. */
  retryBaseMs?: number;
}

/**
 * Telegram-side failures worth one more try: 5xx from the Bot API, or a connection that failed
 * before an answer. A timed-out request is not retried: Telegram may already have posted it,
 * and a duplicate message is worse than a missing edit.
 */
export function isTransientTelegramError(err: unknown): boolean {
  if (err instanceof GrammyError) return err.error_code >= 500;
  if (err instanceof HttpError) return !/timed out/i.test(String((err.error as Error | undefined)?.message));
  return false;
}

/**
 * Send-only Telegram delivery: one bot per scanner, all posting into one chat, each into its
 * own forum topic. Paced per bot below Telegram's group limits (about 20 messages / min per
 * group); waits on HTTP 429 for the `retry_after` Telegram returns.
 */
export class TelegramNotifier implements SignalNotifier {
  readonly #config: TelegramConfig;
  readonly #log: Logger;
  readonly #slots = new Map<ScannerId, BotSlot>();
  readonly #maxRetries: number;
  readonly #retryBaseMs: number;
  readonly #pendingEdits = new Map<string, { html: string; promise: Promise<void> }>();

  constructor(config: TelegramConfig, options: TelegramNotifierOptions) {
    this.#config = config;
    this.#log = options.logger.child({ component: 'telegram' });
    this.#maxRetries = options.maxRetries ?? 3;
    this.#retryBaseMs = options.retryBaseMs ?? 2_000;
    for (const [scanner, bot] of Object.entries(config.bots) as [ScannerId, BotConfig][]) {
      this.#slots.set(scanner, {
        api: new Api(bot.token, {
          timeoutSeconds: options.timeoutSeconds ?? 20,
          ...(options.apiRoot ? { apiRoot: options.apiRoot } : {}),
        }),
        topicId: bot.topicId,
        limiter: new RateLimiter({
          name: `telegram/${scanner}`,
          windows: [
            { limit: 1, windowMs: 1_100 },
            { limit: 18, windowMs: 60_000 },
          ],
          headroom: 1,
        }),
        fatal: null,
      });
    }
  }

  /** Checks every configured token with getMe; a rejected token disables that scanner's bot. */
  async verify(): Promise<void> {
    await Promise.all(
      [...this.#slots].map(async ([scanner, slot]) => {
        try {
          const me = await slot.api.getMe();
          this.#log.info({ scanner, bot: me.username }, 'telegram bot ready');
        } catch (err) {
          if (err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404)) {
            slot.fatal = `bot token rejected by Telegram (${err.description})`;
          }
          this.#log.error({ scanner, err: (err as Error).message }, 'telegram bot check failed');
        }
      }),
    );
  }

  unavailableReason(scanner: ScannerId): string | null {
    if (!this.#config.chatId) return 'TELEGRAM_CHAT_ID is not set';
    const slot = this.#slots.get(scanner);
    if (!slot) return `TELEGRAM_${TELEGRAM_ENV_PREFIX[scanner]}_BOT_TOKEN is not set`;
    return slot.fatal;
  }

  status(scanner: ScannerId): { state: 'ok' | 'disabled' | 'error'; detail: string | null } {
    const reason = this.unavailableReason(scanner);
    if (!reason) return { state: 'ok', detail: null };
    return { state: this.#slots.get(scanner)?.fatal ? 'error' : 'disabled', detail: reason };
  }

  async send(scanner: ScannerId, html: string): Promise<number> {
    const slot = this.#slotOrThrow(scanner);
    const msg = await this.#call(scanner, slot, () =>
      slot.api.sendMessage(this.#config.chatId!, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(slot.topicId !== undefined ? { message_thread_id: slot.topicId } : {}),
      }),
    );
    return msg.message_id;
  }

  edit(scanner: ScannerId, messageId: number, html: string): Promise<void> {
    const key = `${scanner}:${messageId}`;
    const waiting = this.#pendingEdits.get(key);
    if (waiting) {
      waiting.html = html; // a newer edit replaces one that has not been sent yet
      return waiting.promise;
    }
    const slot = this.#slotOrThrow(scanner);
    const entry = { html, promise: Promise.resolve() };
    entry.promise = (async () => {
      await slot.limiter.acquire();
      this.#pendingEdits.delete(key);
      try {
        await this.#call(
          scanner,
          slot,
          () =>
            slot.api.editMessageText(this.#config.chatId!, messageId, entry.html, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            }),
          false,
        );
      } catch (err) {
        // Editing to identical text is not an error for us.
        if (err instanceof GrammyError && /message is not modified/i.test(err.description)) return;
        throw err;
      }
    })();
    this.#pendingEdits.set(key, entry);
    return entry.promise;
  }

  #slotOrThrow(scanner: ScannerId): BotSlot {
    const reason = this.unavailableReason(scanner);
    if (reason) throw new Error(reason);
    return this.#slots.get(scanner)!;
  }

  async #call<T>(scanner: ScannerId, slot: BotSlot, fn: () => Promise<T>, acquire = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (acquire || attempt > 0) await slot.limiter.acquire();
      try {
        return await fn();
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 429 && attempt < this.#maxRetries) {
          const waitMs = ((err.parameters.retry_after ?? 5) + 1) * 1000;
          slot.limiter.pause(waitMs);
          this.#log.warn({ scanner, waitMs }, 'telegram rate limit; waiting');
          continue;
        }
        if (isTransientTelegramError(err) && attempt < this.#maxRetries) {
          const waitMs = this.#retryBaseMs * 2 ** attempt;
          this.#log.warn(
            { scanner, waitMs, err: (err as Error).message },
            'telegram request failed; retrying',
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (
          err instanceof GrammyError &&
          (err.error_code === 401 || /chat not found/i.test(err.description))
        ) {
          slot.fatal = `Telegram rejected the bot or chat (${err.description})`;
        }
        throw err;
      }
    }
  }
}
