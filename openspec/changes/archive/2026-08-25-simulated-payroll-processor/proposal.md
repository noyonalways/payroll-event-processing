## Why

The worker currently "processes" an accepted event by claiming the row and emitting a single log line — there is no per-event-type processing, no result produced, and the two failure-rate environment variables (`PAYROLL_TEMPORARY_FAILURE_RATE`, `PAYROLL_PERMANENT_FAILURE_RATE`) that the scaffold already declares are never consumed. Without an actual processing step behind the `queued → processing → success` transition, the service is not yet a real asynchronous payroll processor, and the reliability changes that follow (retry/failure strategy #5, concurrency/exactly-once #7) have nothing real to act on.

## What Changes

- Introduce a **handler strategy registry** in `src/processing/` mirroring the submission-side `PayloadDtoRegistry` pattern: a common handler interface plus one concrete handler for each existing event type (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`). Adding a new event type becomes a drop-in change (new enum member + payload DTO + handler registration), with no worker or controller edits.
- **Dispatch in the worker**: `PayrollEventProcessor.process()` dispatches to the registry after its guarded `queued → processing` claim — the existing stale/duplicate skip stays intact.
- **Simulated external payroll call**: a shared simulated provider that performs the "external" operation for a handler, with configurable probabilities of transient (`PAYROLL_TEMPORARY_FAILURE_RATE`, default 0.25) and permanent (`PAYROLL_PERMANENT_FAILURE_RATE`, default 0.05) failure, plus a deterministic override knob so tests can force success/transient/permanent outcomes. On success it returns a per-type result (e.g. an external reference plus the acknowledged fields).
- **Success result storage**: a new nullable `result` JSON column on `payroll_events`; on success the provider result is persisted and the row transitions `processing → success` with `processed_at` set.
- **Initial failure handling**: when the simulated provider fails (either class), the row transitions to `failed`. The transient-vs-permanent *handling strategies* — BullMQ retry with exponential backoff, `failedReason`/attempt logging, dead-letter behaviour — are explicitly deferred to change `retry-and-failure-strategy`.
- **Structured lifecycle logging**: worker emits structured log lines around the processing step — claim (exists), `started` (before provider call), `succeeded` / `failed` (outcome) — each carrying `eventId`, `employeeId`, `eventType`, `sequence`, attempt, and worker identity per project convention.

## Capabilities

### New Capabilities
- `event-processing`: per-event-type handler strategy registry, the simulated external provider with configurable transient/permanent failure injection, success-result storage, and the structured processing lifecycle logs.

### Modified Capabilities
- `event-queue`: the "Worker claims and completes jobs with guarded transitions" requirement is extended — between claim and terminal the worker now dispatches through the handler registry, stores the provider's success result (new `result` column), and transitions to `failed` when the simulated call fails. New scenarios cover result storage, failure transition, and lifecycle logging.

## Impact

- **New module**: `src/processing/` (handler interface, registry, per-type handlers, simulated provider, shared errors — transient vs permanent).
- **Worker**: `apps/worker/src/payroll-event.processor.ts` gains dispatch + result/failure handling; `apps/worker/src/worker.module.ts` registers the processing providers and consumes the failure-rate env vars.
- **Schema**: `prisma/schema.prisma` gains a nullable `result Json` column on `payroll_events`; new migration.
- **Config**: `PAYROLL_TEMPORARY_FAILURE_RATE` / `PAYROLL_PERMANENT_FAILURE_RATE` consumed (already declared in API + worker module validation); a deterministic test override is added.
- **Tests**: unit tests for handlers, registry, simulator, and processor dispatch; worker e2e/integration lifecycle coverage for success and failure paths.
- **Docs**: Swagger component schemas for any new DTOs (result body) as applicable.

## Non-goals

- **No retry / backoff / dead-lettering** — transient failures do not yet get re-enqueued; that is change `retry-and-failure-strategy`.
- **No `failedReason` / attempt-history persistence** — deferred to change `retry-and-failure-strategy`.
- **No real third-party payroll integration** — the external call is simulated end-to-end.
- **No concurrency changes** — row locking / exactly-once write improvements remain in change `concurrency-and-crash-recovery`.
- **No new event types** — the three existing types get handlers; extensibility is the pattern, not the payload.