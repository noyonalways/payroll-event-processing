## 1. Configuration

- [x] 1.1 Add `PAYROLL_MAX_RETRY_ATTEMPTS` (default `5`) and `PAYROLL_RETRY_BASE_DELAY_MS` (default `1000`) to the Joi validation schema (wherever the existing `PAYROLL_TEMPORARY_FAILURE_RATE` entries are registered)
- [x] 1.2 Add `PAYROLL_MAX_RETRY_ATTEMPTS` and `PAYROLL_RETRY_BASE_DELAY_MS` with their default values and descriptions to `.env.example`

## 2. Queue Producer — Retry Policy

- [x] 2.1 Inject `ConfigService` into `PayrollEventQueueService` (`src/queue/payroll-event-queue.service.ts`) and read `PAYROLL_MAX_RETRY_ATTEMPTS` and `PAYROLL_RETRY_BASE_DELAY_MS`
- [x] 2.2 Replace `attempts: 1` with the config-driven value and add `backoff: { type: 'exponential', delay: retryBaseDelayMs }` to the `queue.add()` options (**reliability R1**)
- [x] 2.3 Update the unit test in `payroll-event-queue.service.spec.ts` to assert the new `attempts` and `backoff` options are passed through correctly

## 3. Worker Processor — Error Discrimination

- [x] 3.1 In `PayrollEventProcessor.process()` (`apps/worker/src/payroll-event.processor.ts`), update the `catch` block to discriminate `TransientPayrollFailureError` from permanent/unknown errors using `error instanceof TransientPayrollFailureError` (**reliability R1**)
- [x] 3.2 For **transient** errors: run `updateMany({ where: { id: eventId, status: PROCESSING }, data: { status: QUEUED } })` to reset the DB row before re-throwing (**DB row reset — design D2**)
- [x] 3.3 For **transient** errors: emit a `warn`-level structured log entry tagged `retrying` with `eventId`, `employeeId`, `eventType`, `sequence`, current attempt, and max attempts
- [x] 3.4 For **permanent / unknown** errors: keep the existing `updateMany` to `FAILED` and emit an `error`-level log entry tagged `permanent-failure` with failure message

## 4. Worker Processor — Exhausted-Retry Handler

- [x] 4.1 Add an `@OnWorkerEvent('failed')` method in `PayrollEventProcessor` that receives the `job` and `error` (**reliability R1, design D4**)
- [x] 4.2 Inside the handler, check `job.attemptsMade >= (job.opts.attempts ?? 1)` and return early (no-op) when `false` (mid-retry path)
- [x] 4.3 When exhausted: run `updateMany({ where: { id: eventId, status: QUEUED }, data: { status: FAILED } })` to write the terminal `failed` state to the DB (**reliability R1**)
- [x] 4.4 When exhausted: emit a `error`-level structured log entry tagged `exhausted` with `eventId`, `employeeId`, `eventType`, `sequence`, and the failure message

## 5. Unit Tests — Processor Error Paths

- [x] 5.1 Add a unit test: transient failure → row reset to `queued` + `process()` re-throws (verifying BullMQ will retry)
- [x] 5.2 Add a unit test: permanent failure → row written to `failed` + `process()` does not throw
- [x] 5.3 Add a unit test: unknown error (non-`PayrollProcessingError`) → treated as permanent (row `failed`, no re-throw)
- [x] 5.4 Add a unit test: exhausted-retry handler (`job.attemptsMade >= maxAttempts`) → row written to `failed`
- [x] 5.5 Add a unit test: mid-retry `failed` event (`job.attemptsMade < maxAttempts`) → no DB write (handler is a no-op)
- [x] 5.6 Verify log assertions for `retrying`, `permanent-failure`, and `exhausted` structured entries in the unit tests above

## 6. Verification

- [x] 6.1 Run `npm test` (or the workspace equivalent) and confirm all unit tests pass
- [x] 6.2 Manually verify with `PAYROLL_FAILURE_MODE=always-transient` that the worker logs `retrying` for attempts 1–4 and `exhausted` on attempt 5, with the event row finishing as `failed`
- [x] 6.3 Manually verify with `PAYROLL_FAILURE_MODE=always-permanent` that the worker logs `permanent-failure` on attempt 1, with the event row immediately `failed` and no further BullMQ attempts
