## Context

The service already accepts and queues typed payroll events; the worker (`apps/worker/src/payroll-event.processor.ts`) currently "processes" a claimed job by emitting one log line and immediately transitioning `queued → processing → success`. No per-event-type work happens, no processing result is produced or persisted, and the two failure-rate variables the scaffold already validates (`PAYROLL_TEMPORARY_FAILURE_RATE`, `PAYROLL_PERMANENT_FAILURE_RATE` in both `src/app.module.ts` and `apps/worker/src/worker.module.ts`) are never consumed.

This change makes the worker a real processor: it dispatches each claimed event to a handler chosen by a strategy registry, runs a simulated external payroll operation that can fail transiently or permanently at configurable rates, persists a success result, transitions to `failed` on failure, and emits structured lifecycle logs.

The processing folder structure (`src/processing/`) and the submission-side extensibility pattern (`PayloadDtoRegistry` in `src/events/dto/payload-registry.ts`) were both anticipated during scaffolding — this change fills them in.

## Goals / Non-Goals

**Goals:**
- A handler strategy registry keyed by `EventType` that resolves a processor per event type, with new event types as a drop-in addition (additive, no worker/controller edits).
- A simulated external payroll provider whose transient (`PAYROLL_TEMPORARY_FAILURE_RATE`, default 0.25) and permanent (`PAYROLL_PERMANENT_FAILURE_RATE`, default 0.05) failure probabilities come from config and whose outcome is forceable deterministically for tests.
- Success results persisted on the event row (new nullable `result` JSON column), written in the same guarded transition as the `processing → success` update.
- Distinct `started`, `succeeded`, `failed` structured log lines with the project's event context fields, completing the "accepted / started / succeeded / failed" lifecycle.
- Preserve today's guarded claim/skip guarantees exactly: a stale/duplicate job is skipped, never re-processed.

**Non-Goals:**
- No retry, exponential backoff, or dead-lettering — transient failures simply mark the row `failed` for now; retry strategy is change `retry-and-failure-strategy`.
- No `failedReason` / attempt-history persistence — the `failed` transition does not yet store a reason; change `retry-and-failure-strategy`.
- No real third-party integration — the "external" call is simulated (deliberately, per the assignment's simulated-processor scope).
- No concurrency / exactly-once hardening beyond what already exists (guarded updates); change `concurrency-and-crash-recovery`.
- No new event types.

## Decisions

### D1. Handler registry = interface + `Record<EventType, Handler>` (mirrors `PayloadDtoRegistry`)
A small registry module with a `PayrollEventProcessor` interface (e.g. `handle(event): Promise<ProcessingResult>`), one `@Injectable()` handler per event type, and `resolve(eventType)` that throws on an unregistered type.

- **Why**: The submission side already uses this exact pattern (`PayloadDtoRegistry`), it needs no DI ceremony to be testable, and resolving by enum key keeps worker code free of per-type branches.
- **Alternatives considered**: (a) Nest strategy pattern with injected providers over a discriminator — more DI boilerplate, same result; (b) a big switch in the worker — couples worker to every type, violates the extensibility requirement.
- **Reliability concept addressed**: Extensibility (R7) — new event type = new handler + one registry line.

### D2. One shared simulated provider, failure injection via config + deterministic override
A single `SimulatedPayrollProvider` (injectable) reads the two failure-rate env vars and rolls a random outcome per call: `Math.random()` draws against `PERMANENT` first, then `TRANSIENT`, else success. A separate control — env `PAYROLL_FAILURE_MODE=always-success|always-transient|always-permanent` (absent = random) supported by a `FailureConfig` injected into the provider — forces an outcome deterministically.

- **Why**: e2e/integration tests must not be flaky; with rates configured from env (default random) and an override, production behaves realistically while tests pin outcomes. It also gives change `retry-and-failure-strategy` two distinct error classes (`TransientPayrollFailureError`, `PermanentPayrollFailureError`) that already carry `isTransient` metadata to build retry/dead-letter logic on.
- **Alternatives considered**: (a) Fake the provider entirely in every test — works for unit tests, but e2e then never exercises the real dependency wiring; the deterministic override keeps the real path intact. (b) Seeded RNG — more machinery, still flaky-prone; a hard override is simpler and sufficient.
- **Reliability concept addressed**: Temporary vs permanent failure differentiation (R1) groundwork.

### D3. Success result stored in a nullable `result Json` column on `payroll_events`
New column, nullable, no default, in the same table as the lifecycle fields; set only in the guarded `processing → success` update.

- **Why**: The result is 1:1 with the event and written atomically with its terminal status, preserving the existing "success write is guarded and transactional" guarantee (which the JSON column extends — the success write now also carries the result, so a crash-then-reprocess can never apply the change twice *or* double-write a result). A separate `processing_results` table buys nothing before attempt history exists.
- **Alternatives considered**: (a) separate result table — deferred until change `retry-and-failure-strategy` introduces `EventProcessingAttempt`/history, where a child table earns its keep; (b) storing result in `response_body` — conflates API response with processing outcome and pollutes idempotent submission responses.
- **Reliability concept addressed**: Exactly-once processing (R5) — result and terminal status write together under the same status guard.

### D4. Worker failure path = guarded `processing → failed`, no re-enqueue, no reason stored
When the handler throws (transient or permanent in this change's scope), the worker transitions the row to `failed` with a guarded update, logs the failure, and returns without re-enqueueing. BullMQ stays at `attempts: 1`.

- **Why**: Keeps this change coherent and testable: the two failure *classes* are produced here so change `retry-and-failure-strategy` can react to them, but the reaction itself is out of scope. A real `failed` population is exactly what the next change needs to build retries and dead-lettering against.
- **Risk/trade-off**: a transient failure is permanently terminal until #5 lands — acceptable within the staged roadmap (no consumer reads `failed` rows yet), and it means the failure-differentiation groundwork is visible/verifiable now.
- **Reliability concept addressed**: Temporary vs permanent failure (R1); guarded terminal transition preserves crash-safety (R4).

### D5. Lifecycle logging stays on the worker and reuses the existing log context
`started` (before handler dispatch), `succeeded` (result stored), `failed` (handler threw) — each with `eventId`, `employeeId`, `eventType`, `sequence`, attempt, and worker PID, matching today's claim log. Submission-side "accepted" logging already exists and is untouched.

- **Why**: One consistent audit trail across the event lifecycle; the existing logger and context are reused rather than adding a parallel logging mechanism.
- **Reliability concept addressed**: Observability for crash recovery (R4) — an operator can tell exactly where a lifecycle stalled.

## Risks / Trade-offs

- **Random failures make automated tests flaky** → D2's deterministic override (`PAYROLL_FAILURE_MODE`) pins outcomes in e2e/integration; unit tests inject a `FailureConfig` directly.
- **Adding a mutable JSON column with no width cap** → the result shape is bounded by the provider and documented in the spec; result is written only by trusted worker code, not client input.
- **Retiring the "log-only" processing step changes worker behavior** → the guarded claim/skip and relay logic are preserved verbatim; the processing step is replaced inside the existing `process()` flow, keeping the diff surgical.
- **`failed` is terminal with no retry until #5** → intentional staging (see D4); nothing user-facing depends on failed rows yet, and #5's retry/backoff lands before the status API (change `event-status-api`) exposes them.
- **Registry resolve-throws on unknown type** → a bug elsewhere could fail a job; it fails fast with a clear log (per D1) rather than silently skipping, and it is unreachable with the current closed enum.

## Migration Plan

1. Prisma: add nullable `result Json` column; `prisma migrate dev --name add_processing_result` (review generated SQL); `prisma generate`.
2. Add `src/processing/` module + registry + handlers + provider + error classes; register `ProcessingModule` in `apps/worker/src/worker.module.ts`.
3. Update `PayrollEventProcessor.process()` to dispatch via the registry and persist result / transition to `failed`.
4. Wire `PAYROLL_FAILURE_MODE` into the worker and API module validation (allowUnknown already covers absent).
5. **Rollback**: drop the column (migration) and revert the worker to log-only — additive, fully reversible; existing rows are unaffected (`result` nullable).

## Open Questions

- Whether `processedAt` should record failures as well — decided **no** (it stays the success marker, per the existing schema intent); confirmed to match the "success transition sets processed_at" wording in the queued/processing spec history.
- The exact per-type result JSON shape is specified only loosely ("reference + affected fields") so handlers can differ; the design keeps it bounded to: `{ reference, employeeId, effectiveDate, acknowledged: { <field>: value } }`.