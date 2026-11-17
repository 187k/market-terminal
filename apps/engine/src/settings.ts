import {
  defaultSettings,
  parseScannerSettings,
  SCANNER_IDS,
  type CommonSettings,
  type Logger,
  type ScannerId,
} from '@mip/core';
import type { PrismaClient } from '@mip/db';

export interface EffectiveSettings {
  enabled: boolean;
  settings: CommonSettings & Record<string, unknown>;
  /** Stored values that failed validation (defaults were used instead). */
  problems: string[];
}

/** Scanner settings from PostgreSQL, merged with the defaults and validated. */
export class SettingsStore {
  readonly #cache = new Map<ScannerId, EffectiveSettings>();
  readonly #log: Logger;

  constructor(
    private readonly prisma: PrismaClient,
    logger: Logger,
  ) {
    this.#log = logger.child({ component: 'settings' });
    for (const id of SCANNER_IDS) this.#cache.set(id, this.#defaults(id));
  }

  async load(): Promise<void> {
    const rows = await this.prisma.scannerSetting.findMany();
    for (const id of SCANNER_IDS) {
      const row = rows.find((r) => r.scanner === id);
      if (!row) {
        this.#cache.set(id, this.#defaults(id));
        continue;
      }
      const parsed = parseScannerSettings(id, row.settings);
      if (parsed.ok) {
        this.#cache.set(id, {
          enabled: row.enabled,
          settings: parsed.settings as EffectiveSettings['settings'],
          problems: [],
        });
      } else {
        this.#log.error(
          { scanner: id, problems: parsed.problems },
          'stored settings invalid; using defaults',
        );
        this.#cache.set(id, { ...this.#defaults(id), enabled: row.enabled, problems: parsed.problems });
      }
    }
  }

  get(id: ScannerId): EffectiveSettings {
    return this.#cache.get(id)!;
  }

  #defaults(id: ScannerId): EffectiveSettings {
    return { enabled: true, settings: defaultSettings(id) as EffectiveSettings['settings'], problems: [] };
  }
}
