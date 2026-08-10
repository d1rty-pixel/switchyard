import { pino, type Logger } from 'pino';

const isTty = process.stdout.isTTY === true;
const level = process.env.SWITCHYARD_LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

/**
 * Structured logger. Pretty output on a TTY, JSON lines otherwise so the log
 * can be piped into journald / jq without extra flags.
 */
export const logger: Logger = pino({
  level,
  base: { app: 'switchyard' },
  transport: isTty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,app',
          messageFormat: '{msg}',
        },
      }
    : undefined,
});

export type { Logger };
