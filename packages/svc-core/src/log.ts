import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logger. Set LOG_PRETTY=true for human-readable local output (needs pino-pretty). */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  const base = { level, name, base: { service: name }, timestamp: pino.stdTimeFunctions.isoTime };
  if (process.env.LOG_PRETTY === 'true') {
    return pino({ ...base, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino({
    ...base,
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', '*.secret', '*.keypair'], censor: '[redacted]' },
  });
}
