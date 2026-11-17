import type { Logger } from './logger.js';

export const APP_VERSION = process.env.APP_VERSION ?? '0.1.0';

export interface ShutdownOptions {
  /** Hard exit if cleanup takes longer than this. */
  timeoutMs?: number;
}

/**
 * Runs `cleanup` once on SIGINT / SIGTERM (or after an uncaught exception) and exits.
 * Unhandled promise rejections are logged, not fatal.
 */
export function handleShutdown(
  logger: Logger,
  cleanup: (signal: string) => Promise<void>,
  options: ShutdownOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let shuttingDown = false;

  const run = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    try {
      await cleanup(signal);
      logger.info('shutdown complete');
      logger.flush?.();
      process.exit(exitCode);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void run('SIGINT'));
  process.once('SIGTERM', () => void run('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void run('uncaughtException', 1);
  });
}
