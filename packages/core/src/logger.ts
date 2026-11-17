import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/** Paths that must never reach the logs. Applied at the top level and one level deep. */
export const REDACTED_KEYS = [
  'password',
  'secret',
  'apiKey',
  'apiSecret',
  'passphrase',
  'token',
  'authorization',
  'cookie',
] as const;

export const REDACT_PATHS: string[] = [
  ...REDACTED_KEYS,
  ...REDACTED_KEYS.map((k) => `*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-mbx-apikey"]',
  'headers["x-bapi-api-key"]',
  'headers["x-bx-apikey"]',
  'headers["access-key"]',
];

export interface LoggerConfig {
  service: string;
  level?: string;
  /** Human-readable output for local development. Production logs are JSON lines. */
  pretty?: boolean;
}

export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.level ?? 'info',
    base: { service: config.service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (destination) return pino(options, destination);
  if (config.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    };
    return pino(options);
  }
  options.formatters = { level: (label) => ({ level: label }) };
  return pino(options);
}
