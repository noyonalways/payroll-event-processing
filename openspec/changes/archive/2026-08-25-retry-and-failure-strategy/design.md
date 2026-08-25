## Context

The worker (`apps/worker/src/payroll-event.processor.ts`) currently treats every processing failure as immediately terminal — both `TransientPayrollFailureError` and `PermanentPayrollFailureError` flip the event row to `failed` with no retry and no re-enqueue. The queue producer (`src/queue/payroll-event-queue.service.ts`) has a placeholder `attempts: 1` comment that explicitly defers this work to this change. Two error classes already exist and are distinguishable via `PayrollProcessingError.isTransient`.

The reliability contract (R1) states: transient errors MUST retry with exponential backoff; business/validation errors are permanent and MUST NOT retry.

## Goals / Non-Goals

**Goals:**
- Distinguish transient from permanent failures in the BullMQ processor on catch
- Re-throw transient errors so BullMQ schedules retry attempts with exponential backoff
- Reset the DB row (`processing → queued`) before re-throwing so the claim guard on subsequent attempts is satisfied
- Mark permanent failures as `failed` immediately without re-throw
- Handle the exhausted-retry case: when BullMQ gives up (`job.attemptsMade >= maxAttempts`), write the row to `failed`
- Expose configurable `PAYROLL_MAX_RETRY_ATTEMPTS` (default 5) and `PAYROLL_RETRY_BASE_DELAY_MS` (default 1000) env vars
- Emit structured log entries for `retrying` and `permanent-failure` lifecycle stages

**Non-Goals:**
- Dead-letter queue / human alerting on exhausted retries (out of scope)
- Per-event-type retry policy overrides (uniform policy for all types)
- Changing the simulated provider's failure rates or modes
- Row-level locking / exactly-once commit (tracked separately)
- Modifying the idempotency guard or the FIFO relay logic

## Decisions

### D1: Re-throw on transient; swallow on permanent

**Decision**: On catching a `TransientPayrollFailureError`, reset the DB row to `queued` then `throw` the error out of `process()`. For `PermanentPayrollFailureError` (and unknown errors), write `failed` and return without re-throwing.

**Rationale**: BullMQ retries a job only when `process()` throws. Swallowing the error (returning normally) tells BullMQ the job completed successfully — even if the DB row is `failed`. Re-throwing is the correct signal for "try again". Unknown errors are treated as permanent (fail-safe: unknown failures should not loop indefinitely).

**Alternatives considered**:
- Manually re-enqueue via `queueService.enqueue()` on transient — rejected because this bypasses BullMQ's backoff scheduler and resets the `attemptsMade` counter, losing retry budget tracking.

### D2: DB row reset before re-throw

**Decision**: Before re-throwing, run `updateMany({ where: { id, status: PROCESSING }, data: { status: QUEUED } })` to reset the row back to `queued`.

**Rationale**: The claim guard at the start of `process()` does `QUEUED → PROCESSING`. On the next BullMQ attempt the row is still `PROCESSING` (from the previous attempt), so `claimed.count === 0` — the job is silently skipped as stale. Resetting to `QUEUED` before re-throw puts the row back into a claimable state for the next attempt without changing any terminal writes.

**Alternatives considered**:
- Leave the row in `PROCESSING` across attempts and relax the claim guard to also accept `PROCESSING` — rejected because it collapses the "stale/duplicate job" detection that protects exactly-once processing (R5).

### D3: BullMQ exponential backoff via `backoff` option

**Decision**: Pass `{ type: 'exponential', delay: PAYROLL_RETRY_BASE_DELAY_MS }` as the `backoff` option in `queue.add()`. BullMQ computes delay as `baseDelay * 2^(attempt-1)` automatically.

**Rationale**: Native BullMQ backoff requires no custom timer logic and is visible in the BullMQ dashboard. The formula matches the standard exponential-backoff pattern with a configurable base.

**File**: `src/queue/payroll-event-queue.service.ts` — update `attempts` from `1` to `PAYROLL_MAX_RETRY_ATTEMPTS` (read from `ConfigService`) and add `backoff`.

### D4: Exhausted-retry handler via `@OnWorkerEvent('failed')`

**Decision**: Add an `@OnWorkerEvent('failed')` handler in `PayrollEventProcessor`. Inside, check `job.attemptsMade >= job.opts.attempts` to identify exhausted retries (vs. mid-retry failures). When exhausted, write the event row to `failed`.

**Rationale**: When BullMQ retries are exhausted the job moves to the BullMQ failed set (`removeOnFail: true` clears it immediately in our config). The DB row is still in `queued` state (reset from the last transient re-throw). The `failed` worker event is the only reliable hook to detect exhaustion and sync DB state. Mid-retry calls to this handler (when `attemptsMade < maxAttempts`) MUST be no-ops to avoid premature `failed` writes.

**Alternatives considered**:
- Check exhaustion inside `process()` by inspecting `job.opts.attempts` — rejected because `process()` throws before reaching a return path; the exhausted-retry logic must live in a separate hook.

### D5: Config via existing NestJS ConfigService

**Decision**: Read `PAYROLL_MAX_RETRY_ATTEMPTS` and `PAYROLL_RETRY_BASE_DELAY_MS` from `ConfigService` (validated by the existing Joi schema in `src/main.ts` or the queue module). Inject `ConfigService` into `PayrollEventQueueService`.

**Rationale**: All other env-sourced config (failure rates, Redis URL) follows this pattern. Joi defaults provide safe fallback values (`5` and `1000`) without requiring `.env` changes.

**File**: `src/queue/payroll-event-queue.service.ts` — inject `ConfigService`; add Joi defaults for the two new keys.

## Risks / Trade-offs

- **[Risk] Row stuck in `queued` after crash during reset** → If the worker crashes between the `processing → queued` reset and the re-throw, the row is already in `queued`. BullMQ stalled-job detection (R4) will re-queue the job. The claim guard will succeed on the re-queued job because the row is in `queued`. No data is lost.

- **[Risk] `@OnWorkerEvent('failed')` fires for mid-retry errors too** → Mitigated by the `attemptsMade >= maxAttempts` guard inside the handler. Mid-retry calls are pure no-ops.

- **[Risk] `removeOnFail: true` races with `@OnWorkerEvent('failed')`** → BullMQ emits `failed` BEFORE removing the job from the failed set (the event fires on state transition). The handler receives the full `job` object with all metadata. No race.

- **[Trade-off] Unknown errors treated as permanent** → A logic bug that throws an unexpected error type will permanently fail the event without retry. This is intentional (fail-safe) but requires good test coverage of the error classification path.

## Migration Plan

1. Add `PAYROLL_MAX_RETRY_ATTEMPTS` and `PAYROLL_RETRY_BASE_DELAY_MS` to `.env.example` with documented defaults.
2. Add Joi schema entries with `.default()` — no `.env` change required for existing deployments.
3. Deploy updated worker. In-flight jobs (currently `attempts: 1`) will continue with the old policy until completed; new jobs from the updated producer will use the new retry budget.
4. **Rollback**: Revert the worker and producer. Any job currently in a BullMQ retry cycle will exhaust or complete; the DB row will eventually reach a terminal state via the exhausted-retry handler or success.

## Open Questions

- None. The error classes, claim guard pattern, and BullMQ lifecycle hooks are all in place. No schema migration needed.
