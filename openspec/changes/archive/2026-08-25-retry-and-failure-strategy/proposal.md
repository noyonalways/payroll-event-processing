## Why

The worker currently treats every processing failure — transient or permanent — as immediately terminal: both classes flip the event row to `failed` with no retry. The reliability contract (R1) requires that transient failures retry with exponential backoff while business-level permanent failures are permanently rejected without retry. The scaffolded `attempts: 1` placeholder in the queue service makes this a well-defined, bounded gap to close.

## What Changes

- **BullMQ retry policy**: Change `attempts` from `1` to a configurable cap (default 5) with exponential backoff on the queue producer; `removeOnFail` kept `true` so completed job keys remain free.
- **Worker error handling**: In `PayrollEventProcessor.process()`, discriminate `TransientPayrollFailureError` from `PermanentPayrollFailureError`/unknown errors on catch. Transient failures re-throw so BullMQ schedules the next attempt; permanent failures mark the row `failed` immediately and do not re-throw.
- **DB row reset on re-queue**: Before re-throwing a transient error, reset the event row from `processing → queued` so the claim guard on the next BullMQ attempt succeeds (the row will not be in `queued` state otherwise, causing the retry to be skipped as stale).
- **Retry configuration**: Expose `PAYROLL_MAX_RETRY_ATTEMPTS` (default `5`) and `PAYROLL_RETRY_BASE_DELAY_MS` (default `1000`) environment variables; wire into queue options.
- **Exhausted-retry terminal failure**: When BullMQ exhausts all attempts (job `failed` event, `job.attemptsMade >= maxAttempts`), write the event row to `failed` so the DB state is consistent with the queue state.
- **Structured logging**: Emit structured log lines for `retrying` (transient, attempt N of M) and `permanent-failure` (no retry) stages with full event context.

## Capabilities

### New Capabilities

- `retry-failure-handling`: Worker-level transient/permanent failure discrimination, BullMQ exponential-backoff retry policy, DB row state management across retry attempts, and exhausted-retry terminal write.

### Modified Capabilities

- `event-processing`: Adds retry lifecycle requirements — the processing pipeline now has a `retrying` intermediate path in addition to `success` and `failed` terminals. The `simulated-provider` failure-rate behaviour is unchanged; only the consumer-side reaction to those failures is being specified.

## Impact

- **`src/queue/payroll-event-queue.service.ts`**: Update `attempts` and add `backoff` options; read from config.
- **`apps/worker/src/payroll-event.processor.ts`**: Discriminate errors on catch; reset row on transient; add `failed` worker-event handler for exhausted retries.
- **`src/queue/queue.module.ts`** / **`apps/worker/src/worker.module.ts`**: Pass retry config through to queue options.
- **Environment config** (`.env.example`, Joi schema): Add `PAYROLL_MAX_RETRY_ATTEMPTS` and `PAYROLL_RETRY_BASE_DELAY_MS`.
- **Tests**: Unit tests for the processor's transient/permanent/exhausted paths; integration smoke confirming BullMQ retries fire.
