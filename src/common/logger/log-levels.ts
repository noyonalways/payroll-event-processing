import { LogLevel } from '@nestjs/common';

/**
 * Maps a `LOG_LEVEL` env value (error | warn | log | debug | verbose) to the
 * NestJS `LogLevel[]` a bootstrap passes to `app.useLogger(...)`. Each level
 * includes its quieter ones, quietest → noisiest.
 *
 * Default (`log`) keeps the reviewer demo arc clean — submission idempotency,
 * `Processing … started`, and the terminal succeeded / retrying / exhausted
 * verdicts — while the per-event relay breadcrumbs (`Enqueued …`,
 * `Relaying next …` in the queue service / processor) are verbose-level and
 * stay hidden. `debug` / `verbose` re-enable them for troubleshooting.
 */
const LEVELS: Record<string, LogLevel[]> = {
  error: ['error'],
  warn: ['error', 'warn'],
  log: ['error', 'warn', 'log'],
  debug: ['error', 'warn', 'log', 'debug'],
  verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
};

export function logLevelsFor(level: string | undefined): LogLevel[] {
  return LEVELS[level ?? 'log'] ?? LEVELS.log;
}
