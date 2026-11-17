import type { Logger, ScannerId, ScannerStatusDto } from '@mip/core';
import type { ScannerDefinition } from './scanners/types.js';
import type { SettingsStore } from './settings.js';
import type { SignalEngine } from './signals.js';
import type { MarketView } from './view.js';

interface RunState {
  lastRunAt: number | null;
  lastRunMs: number | null;
  evaluated: number;
  candidates: number;
  warnings: string[];
  error: string | null;
}

export interface RunnerOptions {
  scanners: ScannerDefinition<any>[];
  engine: SignalEngine;
  settings: SettingsStore;
  telegramStatus: (id: ScannerId) => { state: 'ok' | 'disabled' | 'error'; detail: string | null };
  logger: Logger;
}

/**
 * Runs each enabled scanner on its own interval against the current market view and feeds
 * the results to the signal engine. A scanner that throws is reported, never stops the others.
 */
export class ScannerRunner {
  readonly #opts: RunnerOptions;
  readonly #log: Logger;
  readonly #state = new Map<ScannerId, RunState>();

  constructor(options: RunnerOptions) {
    this.#opts = options;
    this.#log = options.logger.child({ component: 'runner' });
    for (const s of options.scanners) {
      this.#state.set(s.id, {
        lastRunAt: null,
        lastRunMs: null,
        evaluated: 0,
        candidates: 0,
        warnings: [],
        error: null,
      });
    }
  }

  get scanners(): ScannerDefinition<any>[] {
    return this.#opts.scanners;
  }

  async tick(view: MarketView, now: number): Promise<void> {
    for (const def of this.#opts.scanners) {
      const st = this.#state.get(def.id)!;
      const cfg = this.#opts.settings.get(def.id);
      if (st.lastRunAt !== null && now - st.lastRunAt < def.intervalMs) continue;
      if (!cfg.enabled) {
        // A switched-off scanner finds nothing, so its open signals resolve after the usual
        // resolveAfterSec instead of staying "active" until it is switched back on.
        if (this.#opts.engine.active(def.id).length > 0)
          this.#opts.engine.process(def.id, cfg.settings, [], now);
        st.lastRunAt = now;
        continue;
      }
      const started = performance.now();
      try {
        const result = await def.evaluate(view, cfg.settings, now);
        this.#opts.engine.process(def.id, cfg.settings, result.candidates, now);
        Object.assign(st, {
          evaluated: result.evaluated,
          candidates: result.candidates.length,
          warnings: [
            ...cfg.problems.map((p) => `invalid stored setting, default used: ${p}`),
            ...result.warnings,
          ],
          error: null,
        });
      } catch (err) {
        st.error = (err as Error).message;
        this.#log.error({ scanner: def.id, err }, 'scanner failed');
      }
      st.lastRunAt = now;
      st.lastRunMs = Math.round((performance.now() - started) * 10) / 10;
    }
  }

  statuses(counts: Map<string, { count: number; last: number | null }>): ScannerStatusDto[] {
    return this.#opts.scanners.map((def) => {
      const st = this.#state.get(def.id)!;
      const cfg = this.#opts.settings.get(def.id);
      const telegram = cfg.settings.notifyTelegram
        ? this.#opts.telegramStatus(def.id)
        : { state: 'disabled' as const, detail: 'switched off in the scanner settings' };
      return {
        id: def.id,
        enabled: cfg.enabled,
        lastRunAt: st.lastRunAt,
        lastRunMs: st.lastRunMs,
        evaluated: st.evaluated,
        candidates: st.candidates,
        active: this.#opts.engine.active(def.id).length,
        signals24h: counts.get(def.id)?.count ?? 0,
        lastSignalAt: counts.get(def.id)?.last ?? null,
        telegram,
        warnings: st.warnings,
        error: st.error,
      };
    });
  }
}
