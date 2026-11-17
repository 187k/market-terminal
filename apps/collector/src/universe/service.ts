import type { ExchangeId, InstrumentInfo, Logger, MarketsBootstrap, UniverseInfo } from '@mip/core';
import type { CoinGeckoClient, CoinMarket } from '@mip/connectors';
import type { Prisma, PrismaClient } from '@mip/db';
import {
  extendUniverse,
  quoteKey,
  selectByMarketCap,
  selectByVolume,
  symbolsFor,
  type Quote,
  type SelectOptions,
} from './select.js';

export interface UniverseSettings {
  size: number;
  ranking: 'market_cap' | 'volume';
  refreshHours: number;
  maxDeviation: number;
}

interface StoredInputs {
  universe: UniverseInfo;
  coins: CoinMarket[];
  excludedIds: string[];
}

export interface UniverseServiceOptions {
  logger: Logger;
  prisma: PrismaClient;
  coingecko: CoinGeckoClient;
  settings: UniverseSettings;
  /** Exchanges whose markets the first build waits for. */
  expected: readonly ExchangeId[];
  /** Longest wait for slow exchanges before the first build goes ahead without them. */
  initialWaitMs?: number;
  /** Called whenever the universe or the instrument set changes. */
  onChange: (universe: UniverseInfo, instruments: Map<ExchangeId, InstrumentInfo[]>) => void;
}

/** Latest price and turnover per instrument, merged from a bootstrap's REST updates. */
export function quotesFrom(exchange: ExchangeId, boot: MarketsBootstrap): Map<string, Quote> {
  const merged = new Map<string, { mark?: number; last?: number; turnover24h?: number }>();
  for (const u of boot.updates) {
    const cur = merged.get(u.symbol) ?? {};
    if (u.values.mark !== undefined) cur.mark = u.values.mark;
    if (u.values.last !== undefined) cur.last = u.values.last;
    if (u.values.turnover24h !== undefined) cur.turnover24h = u.values.turnover24h;
    merged.set(u.symbol, cur);
  }
  const out = new Map<string, Quote>();
  for (const [symbol, v] of merged) {
    const price = v.mark ?? v.last;
    if (price !== undefined && price > 0)
      out.set(quoteKey(exchange, symbol), { price, turnover: v.turnover24h ?? null });
  }
  return out;
}

/**
 * Builds and maintains the instrument universe: the N largest crypto assets and the
 * perpetuals that represent them on each exchange.
 */
export class UniverseService {
  readonly #opts: UniverseServiceOptions;
  readonly #log: Logger;
  readonly #boots = new Map<ExchangeId, MarketsBootstrap>();
  readonly #reported = new Set<ExchangeId>();
  #universe: UniverseInfo | null = null;
  #needsRefresh = false;
  #building: Promise<UniverseInfo> | null = null;
  #waitTimer: NodeJS.Timeout | null = null;
  #releaseWait: (() => void) | null = null;
  readonly #waitDone: Promise<void>;

  constructor(options: UniverseServiceOptions) {
    this.#opts = options;
    this.#log = options.logger.child({ component: 'universe' });
    this.#waitDone = new Promise((resolve) => (this.#releaseWait = resolve));
    if (options.expected.length === 0) this.#releaseWait?.();
  }

  get current(): UniverseInfo | null {
    return this.#universe;
  }

  /** True when the first build used an outdated stored ranking; the caller should refresh soon. */
  get needsRefresh(): boolean {
    return this.#needsRefresh;
  }

  instruments(): Map<ExchangeId, InstrumentInfo[]> {
    return new Map([...this.#boots].map(([ex, b]) => [ex, b.instruments]));
  }

  /** Supervisor hook: an exchange's markets are loaded; returns the symbols to stream. */
  async select(exchange: ExchangeId, boot: MarketsBootstrap): Promise<string[]> {
    this.#boots.set(exchange, boot);
    this.#report(exchange);
    const universe = await this.#ensureBuilt();
    const inUniverse = universe.assets.some((a) => a.instruments.some((i) => i.exchange === exchange));
    if (!inUniverse && !this.#building) {
      // Joined after the build (it was down at start-up): map it onto the existing assets.
      this.#universe = extendUniverse(
        universe,
        exchange,
        boot.instruments,
        quotesFrom(exchange, boot),
        this.#opts.settings.maxDeviation,
      );
      this.#log.info(
        { exchange, tracked: symbolsFor(this.#universe, exchange).length },
        'exchange added to universe',
      );
      await this.#persistRegistry(this.#universe).catch((err: Error) =>
        this.#log.warn({ err: err.message }, 'registry write failed'),
      );
      this.#opts.onChange(this.#universe, this.instruments());
    }
    return symbolsFor(this.#universe!, exchange);
  }

  /** Supervisor hook: an exchange could not be loaded; the first build does not wait for it. */
  loadFailed(exchange: ExchangeId): void {
    this.#report(exchange);
  }

  /**
   * Rebuilds with fresh CoinGecko data and freshly loaded instruments. Returns the new universe;
   * the caller applies the new tracked sets.
   */
  async refresh(boots: Map<ExchangeId, MarketsBootstrap>): Promise<UniverseInfo> {
    for (const [ex, boot] of boots) this.#boots.set(ex, boot);
    this.#needsRefresh = false;
    this.#building = this.#build(true);
    try {
      this.#universe = await this.#building;
    } finally {
      this.#building = null;
    }
    this.#opts.onChange(this.#universe, this.instruments());
    return this.#universe;
  }

  stop(): void {
    if (this.#waitTimer) clearTimeout(this.#waitTimer);
    this.#releaseWait?.();
  }

  #report(exchange: ExchangeId): void {
    this.#reported.add(exchange);
    if (this.#opts.expected.every((e) => this.#reported.has(e))) {
      this.#releaseWait?.();
    } else if (!this.#waitTimer) {
      this.#waitTimer = setTimeout(() => {
        const missing = this.#opts.expected.filter((e) => !this.#reported.has(e));
        this.#log.warn({ missing }, 'building the universe without exchanges that are still loading');
        this.#releaseWait?.();
      }, this.#opts.initialWaitMs ?? 30_000);
      this.#waitTimer.unref();
    }
  }

  async #ensureBuilt(): Promise<UniverseInfo> {
    if (this.#universe) return this.#universe;
    await this.#waitDone;
    if (this.#universe) return this.#universe;
    if (!this.#building) {
      this.#building = this.#build(false).finally(() => {
        if (this.#waitTimer) clearTimeout(this.#waitTimer);
      });
      this.#universe = await this.#building;
      this.#building = null;
      this.#opts.onChange(this.#universe, this.instruments());
      return this.#universe;
    }
    return this.#building;
  }

  #selectOptions(): SelectOptions {
    const instruments: InstrumentInfo[] = [];
    const quotes = new Map<string, Quote>();
    for (const [ex, boot] of this.#boots) {
      instruments.push(...boot.instruments);
      for (const [k, q] of quotesFrom(ex, boot)) quotes.set(k, q);
    }
    return {
      size: this.#opts.settings.size,
      instruments,
      quotes,
      maxDeviation: this.#opts.settings.maxDeviation,
    };
  }

  async #build(forceFresh: boolean): Promise<UniverseInfo> {
    const { settings } = this.#opts;
    // Instruments are read as late as possible: exchanges may finish loading during the CoinGecko download.
    const opts = () => this.#selectOptions();
    let universe: UniverseInfo;

    if (settings.ranking === 'volume') {
      universe = selectByVolume(opts());
      universe.warnings = [
        'ranked by 24 h perpetual turnover (UNIVERSE_RANKING=volume); market cap is not shown',
      ];
    } else {
      const cached = await this.#latestInputs().catch((err: Error) => {
        this.#log.warn({ err: err.message }, 'could not read the cached universe');
        return null;
      });
      const fresh = cached && Date.now() - cached.universe.builtAt < settings.refreshHours * 3_600_000;
      const cachedAge = cached ? Date.now() - cached.universe.builtAt : 0;
      // At start-up any stored ranking is used at once, so market data never waits for
      // CoinGecko; an outdated one is refreshed in the background (see needsRefresh).
      if (cached && !forceFresh) {
        universe = selectByMarketCap(cached.coins, new Set(cached.excludedIds), {
          ...opts(),
          referenceAgeMs: cachedAge,
        });
        universe.builtAt = cached.universe.builtAt;
        this.#needsRefresh = !fresh;
        if (!fresh)
          universe.warnings.push(
            `ranking from ${new Date(cached.universe.builtAt).toISOString()} is older than ${settings.refreshHours} h; refreshing from CoinGecko in the background`,
          );
        this.#log.info(
          { builtAt: new Date(cached.universe.builtAt).toISOString(), refreshing: !fresh },
          'using the stored CoinGecko ranking',
        );
      } else {
        try {
          const inputs = await this.#fetchCoinGecko(opts);
          universe = inputs.universe;
          await this.#saveInputs(inputs).catch((err: Error) =>
            this.#log.warn({ err: err.message }, 'saving universe failed'),
          );
        } catch (err) {
          const message = (err as Error).message;
          if (cached) {
            universe = selectByMarketCap(cached.coins, new Set(cached.excludedIds), {
              ...opts(),
              referenceAgeMs: cachedAge,
            });
            universe.builtAt = cached.universe.builtAt;
            universe.warnings.push(
              `CoinGecko unavailable (${message}); using the ranking from ${new Date(cached.universe.builtAt).toISOString()}`,
            );
          } else {
            universe = selectByVolume(opts());
            universe.warnings.unshift(`CoinGecko unavailable (${message}) and no cached ranking`);
          }
          this.#log.error({ err: message }, 'CoinGecko unavailable; universe built from fallback');
        }
      }
    }

    this.#log.info(
      {
        source: universe.source,
        assets: universe.assets.length,
        instruments: universe.assets.reduce((n, a) => n + a.instruments.length, 0),
        problems: universe.problems.length,
        warnings: universe.warnings,
      },
      'universe built',
    );
    await this.#persistRegistry(universe).catch((err: Error) =>
      this.#log.warn({ err: err.message }, 'registry write failed'),
    );
    return universe;
  }

  async #fetchCoinGecko(options: () => SelectOptions): Promise<StoredInputs> {
    const cg = this.#opts.coingecko;
    this.#log.info(
      { plan: cg.plan },
      cg.plan === 'public'
        ? 'loading CoinGecko ranking without an API key (about 5 calls per minute; takes up to 2 minutes)'
        : 'loading CoinGecko ranking',
    );
    const excludedIds = await cg.excludedIds();
    const excluded = new Set(excludedIds);
    const coins: CoinMarket[] = [];
    let universe: UniverseInfo | null = null;
    for (let page = 1; page <= 4; page++) {
      coins.push(...(await cg.marketsPage(page)));
      const opts = options();
      universe = selectByMarketCap(coins, excluded, opts);
      if (universe.assets.length >= opts.size) break;
    }
    return { universe: universe!, coins, excludedIds };
  }

  async #latestInputs(): Promise<StoredInputs | null> {
    const row = await this.#opts.prisma.universeSnapshot.findFirst({
      where: { source: 'coingecko' },
      orderBy: { builtAt: 'desc' },
    });
    if (!row) return null;
    const data = row.data as unknown as StoredInputs;
    return Array.isArray(data?.coins) && data.universe ? data : null;
  }

  async #saveInputs(inputs: StoredInputs): Promise<void> {
    const prisma = this.#opts.prisma;
    await prisma.universeSnapshot.create({
      data: {
        builtAt: new Date(inputs.universe.builtAt),
        source: inputs.universe.source,
        size: inputs.universe.size,
        data: inputs as unknown as Prisma.InputJsonValue,
      },
    });
    // Keep 30 days of history.
    await prisma.universeSnapshot.deleteMany({
      where: { builtAt: { lt: new Date(Date.now() - 30 * 86_400_000) } },
    });
  }

  async #persistRegistry(universe: UniverseInfo): Promise<void> {
    const byKey = new Map<string, InstrumentInfo>();
    for (const boot of this.#boots.values())
      for (const i of boot.instruments) byKey.set(quoteKey(i.exchange, i.symbol), i);
    const now = new Date();
    const rows: Prisma.InstrumentCreateManyInput[] = [];
    for (const asset of universe.assets) {
      for (const ref of asset.instruments) {
        const i = byKey.get(quoteKey(ref.exchange, ref.symbol));
        if (!i) continue;
        rows.push({
          exchange: i.exchange,
          symbol: i.symbol,
          assetId: asset.id,
          asset: i.asset,
          base: i.base,
          quote: i.quote,
          multiplier: i.multiplier,
          contractSize: i.contractSize,
          tickSize: i.tickSize,
          maxLeverage: i.maxLeverage.available ? i.maxLeverage.value : null,
          indexKind: i.indexKind,
          launchTime: i.launchTime ? new Date(i.launchTime) : null,
          url: i.url,
          updatedAt: now,
        });
      }
    }
    await this.#opts.prisma.$transaction([
      this.#opts.prisma.instrument.deleteMany({}),
      this.#opts.prisma.instrument.createMany({ data: rows }),
    ]);
  }
}
