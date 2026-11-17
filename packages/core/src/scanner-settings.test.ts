import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  mergeSettings,
  parseScannerSettings,
  settingsJsonSchema,
} from './scanner-settings.js';

describe('mergeSettings', () => {
  it('keeps nested keys a partial update leaves out', () => {
    const current = defaultSettings('open-interest');
    const merged = mergeSettings(current, { thresholds: { '1h': { growthPct: 20 } } });
    const parsed = parseScannerSettings('open-interest', merged);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.thresholds).toEqual({
      '5m': { growthPct: 3, declinePct: 3 },
      '30m': { growthPct: 8, declinePct: 6 },
      '1h': { growthPct: 20, declinePct: 8 },
      '4h': { growthPct: 25, declinePct: 15 },
    });
  });

  it('replaces arrays and scalars instead of merging them', () => {
    const merged = mergeSettings(
      { exchanges: ['bybit', 'gate'], minTurnover24hUsd: 1, takerFees: { bybit: 0.1, gate: 0.2 } },
      { exchanges: ['mexc'], minTurnover24hUsd: 2, takerFees: { gate: 0.3 } },
    );
    expect(merged).toEqual({
      exchanges: ['mexc'],
      minTurnover24hUsd: 2,
      takerFees: { bybit: 0.1, gate: 0.3 },
    });
  });

  it('does not modify its inputs', () => {
    const current = { takerFees: { bybit: 0.1 } };
    mergeSettings(current, { takerFees: { bybit: 0.2 } });
    expect(current).toEqual({ takerFees: { bybit: 0.1 } });
  });
});

describe('settingsJsonSchema', () => {
  it('exposes types, bounds and allowed values for a form', () => {
    const schema = settingsJsonSchema('fair-price') as {
      properties: Record<
        string,
        { type?: string; minimum?: number; maximum?: number; items?: { enum?: string[] } }
      >;
    };
    expect(schema.properties.minDeviationPct).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
    expect(schema.properties.notifyTelegram).toMatchObject({ type: 'boolean' });
    expect(schema.properties.exchanges?.items?.enum).toContain('hyperliquid');
  });
});
