/**
 * BullMQ `Worker` options for the `payroll-events` consumer (design D3).
 *
 * Computed at MODULE IMPORT — never lazily. `@Processor`'s second argument is
 * consumed by the BullRegistrar as class-definition metadata, and @nestjs/config
 * freezes `process.env` at import time, so env-driven values must be resolved
 * the moment the module graph loads this file.
 *
 * - lockDuration (default 30_000) must comfortably exceed the processing
 *   transaction's `{ timeout: 10_000 }` so a healthy worker can never be
 *   declared stalled while its row lock is held inside the tx.
 * - stalledInterval (default 30_000) / maxStalledCount (default 1) define the
 *   re-queue schedule for a job whose worker died mid-work. Combined with
 *   event-claim.ts (design D1), a re-queued job finds its row rolled back to
 *   `queued` and reprocesses it.
 */
export const WORKER_OPTIONS = {
  concurrency: 1, // per-employee FIFO: one job at a time per worker
  lockDuration: Number(process.env.PAYROLL_WORKER_LOCK_DURATION_MS ?? 30_000),
  stalledInterval: Number(process.env.PAYROLL_WORKER_STALLED_INTERVAL_MS ?? 30_000),
  maxStalledCount: Number(process.env.PAYROLL_WORKER_MAX_STALLED_COUNT ?? 1),
} as const;