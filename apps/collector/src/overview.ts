import type { StoredMarketOverview } from '@mip/bus';
import type { CoinSpotStats, GlobalMarketStats, Logger, UniverseInfo } from '@mip/core';

/** The CoinGecko calls the poller needs (CoinGeckoClient; a stub in tests). */
export interface OverviewSource {
  coinsByIds(ids: readonly string[]): Promise<CoinSpotStats[]>;
  global(): Promise<GlobalMarketStats>;
}

export interface OverviewPollerOptions {
  source: OverviewSource;
  write: (value: StoredMarketOverview) => Promise<void>;
  logger: Logger;
  refreshMs: number;
  now?: () => number;
}

/**
 * CoinGecko ids of the universe's assets. Only a CoinGecko-ranked universe has them; a
 * volume-ranked one uses asset codes as ids, which CoinGecko would not recognise.
 */
export function overviewIds(universe: UniverseInfo | null): string[] | null {
  if (!universe || universe.source !== 'coingecko') return null;
  return universe.assets.map((a) => a.id);
}

/**
 * Polls CoinGecko for the home page: spot figures of the universe's coins and the global
 * market stats, written to Redis after every poll. A failed part keeps its last good data and
 * time and records the error, so the page shows old data as old. Polls never overlap and are
 * spaced `refreshMs` apart; the CoinGecko client's shared limiter keeps them inside the budget
 * the universe build also uses.
 */
export class MarketOverviewPoller {
  readonly #opts: OverviewPollerOptions;
  readonly #log: Logger;
  readonly #now: () => number;
  #ids: string[] | null = null;
  #state: StoredMarketOverview;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #stopped = true;
  readonly #failing = { coins: false, global: false };

  constructor(options: OverviewPollerOptions) {
    this.#opts = options;
    this.#log = options.logger.child({ component: 'overview' });
    this.#now = options.now ?? Date.now;
    this.#state = {
      coins: null,
      coinsError: null,
      global: null,
      globalError: null,
      refreshMs: options.refreshMs,
    };
  }

  get state(): StoredMarketOverview {
    return this.#state;
  }

  start(): void {
    this.#stopped = false;
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * New universe. Coins that have never been fetched are fetched right away (the first poll
   * usually runs before the universe is built); otherwise the next regular poll picks them up.
   */
  setUniverse(universe: UniverseInfo | null): void {
    this.#ids = overviewIds(universe);
    if (!this.#stopped && this.#state.coins === null && this.#ids?.length && !this.#running)
      this.#schedule(0);
  }

  /** One poll: both parts, then one write. Exposed for tests. */
  poll(): Promise<void> {
    this.#running ??= this.#poll().finally(() => (this.#running = null));
    return this.#running;
  }

  #schedule(delayMs: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.poll().finally(() => {
        if (!this.#stopped) this.#schedule(this.#opts.refreshMs);
      });
    }, delayMs);
    this.#timer.unref();
  }

  async #poll(): Promise<void> {
    const ids = this.#ids;
    const [coins, global] = await Promise.allSettled([
      ids && ids.length > 0 ? this.#opts.source.coinsByIds(ids) : Promise.resolve(null),
      this.#opts.source.global(),
    ]);
    const now = this.#now();
    const next: StoredMarketOverview = { ...this.#state, refreshMs: this.#opts.refreshMs };
    if (coins.status === 'fulfilled') {
      if (coins.value !== null) {
        next.coins = { data: coins.value, fetchedAt: now };
        next.coinsError = null;
        this.#recovered('coins');
      }
    } else {
      next.coinsError = { message: errorText(coins.reason), at: now };
      this.#failed('coins', next.coinsError.message);
    }
    if (global.status === 'fulfilled') {
      next.global = { data: global.value, fetchedAt: now };
      next.globalError = null;
      this.#recovered('global');
    } else {
      next.globalError = { message: errorText(global.reason), at: now };
      this.#failed('global', next.globalError.message);
    }
    this.#state = next;
    await this.#opts
      .write(next)
      .catch((err: Error) => this.#log.warn({ err: err.message }, 'writing the market overview failed'));
  }

  // Logged once per outage, not on every poll.
  #failed(part: 'coins' | 'global', message: string): void {
    if (this.#failing[part]) return;
    this.#failing[part] = true;
    this.#log.warn({ part, err: message }, 'CoinGecko overview request failed; keeping the last data');
  }

  #recovered(part: 'coins' | 'global'): void {
    if (!this.#failing[part]) return;
    this.#failing[part] = false;
    this.#log.info({ part }, 'CoinGecko overview request recovered');
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
