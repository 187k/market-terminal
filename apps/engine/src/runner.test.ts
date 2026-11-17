import { describe, expect, it, vi } from 'vitest';
import { createLogger, defaultSettings } from '@mip/core';
import { ScannerRunner } from './runner.js';
import type { ScannerDefinition } from './scanners/types.js';
import type { SettingsStore } from './settings.js';
import type { SignalEngine } from './signals.js';
import type { MarketView } from './view.js';

const logger = createLogger({ service: 'test', level: 'silent' });

function setup(enabled: boolean, activeCount: number) {
  const evaluate = vi.fn(async () => ({ candidates: [], evaluated: 3, warnings: [] }));
  const def = { id: 'fair-price', intervalMs: 1_000, evaluate } as unknown as ScannerDefinition<any>;
  const engine = {
    process: vi.fn(),
    active: vi.fn(() => Array.from({ length: activeCount }, () => ({}))),
  } as unknown as SignalEngine & { process: ReturnType<typeof vi.fn> };
  const settings = {
    get: () => ({ enabled, settings: defaultSettings('fair-price'), problems: [] }),
  } as unknown as SettingsStore;
  const runner = new ScannerRunner({
    scanners: [def],
    engine,
    settings,
    telegramStatus: () => ({ state: 'ok', detail: null }),
    logger,
  });
  return { runner, evaluate, engine };
}

const view = {} as MarketView;

describe('ScannerRunner', () => {
  it('evaluates an enabled scanner on its interval', async () => {
    const t = setup(true, 0);
    await t.runner.tick(view, 0);
    await t.runner.tick(view, 500);
    await t.runner.tick(view, 1_000);
    expect(t.evaluate).toHaveBeenCalledTimes(2);
    expect(t.engine.process).toHaveBeenCalledTimes(2);
  });

  it('lets the open signals of a disabled scanner resolve instead of freezing them', async () => {
    const t = setup(false, 2);
    await t.runner.tick(view, 0);
    expect(t.evaluate).not.toHaveBeenCalled();
    expect(t.engine.process).toHaveBeenCalledWith('fair-price', expect.anything(), [], 0);
  });

  it('does nothing for a disabled scanner without open signals', async () => {
    const t = setup(false, 0);
    await t.runner.tick(view, 0);
    expect(t.evaluate).not.toHaveBeenCalled();
    expect(t.engine.process).not.toHaveBeenCalled();
  });
});
