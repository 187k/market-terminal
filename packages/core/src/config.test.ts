import { describe, expect, it } from 'vitest';
import { apiEnvSchema, apiSecurityWarnings, collectorEnvSchema, ConfigError, parseEnv } from './config.js';

const base = { REDIS_URL: 'redis://localhost:6379', DATABASE_URL: 'postgresql://u:p@localhost:5433/db' };

describe('parseEnv', () => {
  it('applies defaults and coerces types', () => {
    const env = parseEnv(apiEnvSchema, {
      ...base,
      DASHBOARD_USER: 'admin',
      DASHBOARD_PASSWORD: 'pw',
      SESSION_SECRET: 'x'.repeat(32),
      API_PORT: '4000',
      LOG_PRETTY: 'true',
    });
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.SESSION_TTL_HOURS).toBe(168);
    expect(env.NODE_ENV).toBe('development');
  });

  it('treats empty strings as unset', () => {
    const env = parseEnv(collectorEnvSchema, { ...base, EXCHANGES_ENABLED: '', LOG_LEVEL: '' });
    expect(env.EXCHANGES_ENABLED).toHaveLength(7);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('parses and de-duplicates the exchange list', () => {
    const env = parseEnv(collectorEnvSchema, { ...base, EXCHANGES_ENABLED: 'Bybit, binance,bybit' });
    expect(env.EXCHANGES_ENABLED).toEqual(['bybit', 'binance']);
  });

  it('rejects unknown exchanges', () => {
    expect(() => parseEnv(collectorEnvSchema, { ...base, EXCHANGES_ENABLED: 'bybit,okx' })).toThrow(/okx/);
  });

  it('lists every problem and never echoes values', () => {
    const secret = 'short-secret';
    try {
      parseEnv(apiEnvSchema, { REDIS_URL: 'not a url', SESSION_SECRET: secret });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.problems.join('\n')).toMatch(/DATABASE_URL: is required/);
      expect(e.problems.join('\n')).toMatch(/DASHBOARD_USER: is required/);
      expect(e.problems.join('\n')).toMatch(/REDIS_URL/);
      expect(e.problems.join('\n')).toMatch(/SESSION_SECRET: must be at least 16 characters/);
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain('not a url');
    }
  });
});

describe('apiSecurityWarnings', () => {
  const safe = {
    NODE_ENV: 'production' as const,
    DASHBOARD_PASSWORD: 'a-long-dashboard-pass',
    SESSION_SECRET: 'x'.repeat(40),
    COOKIE_SECURE: true,
    DATABASE_URL: 'postgresql://mip:s3cret-pw@postgres:5432/mip',
  };

  it('is silent for a safe production setup and outside production', () => {
    expect(apiSecurityWarnings(safe)).toEqual([]);
    expect(
      apiSecurityWarnings({
        ...safe,
        NODE_ENV: 'development',
        DASHBOARD_PASSWORD: 'change-me',
        COOKIE_SECURE: false,
      }),
    ).toEqual([]);
  });

  it('names weak settings without their values', () => {
    const w = apiSecurityWarnings({
      ...safe,
      DASHBOARD_PASSWORD: 'change-me',
      SESSION_SECRET: 'sixteen-chars-ok',
      COOKIE_SECURE: false,
      DATABASE_URL: 'postgresql://mip:mip@postgres:5432/mip',
    });
    expect(w).toEqual([
      'DASHBOARD_PASSWORD is still the example value',
      'SESSION_SECRET is shorter than 32 characters',
      'COOKIE_SECURE is false: fine on localhost, but set it to true when the dashboard is served over HTTPS',
      'the database password is the default (POSTGRES_PASSWORD)',
    ]);
    expect(w.join(' ')).not.toContain('sixteen-chars-ok');
  });
});
