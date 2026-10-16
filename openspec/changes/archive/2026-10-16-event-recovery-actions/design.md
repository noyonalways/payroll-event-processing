# Design

## Context

See `proposal.md` — Why. Constraints that shape the design:

- The worker round-trip (`packages/core/src/worker/payroll-event.processor.ts` + `packages/core/src/processing/event-claim.ts`) is a single guarded transaction: `SELECT … FOR UPDATE` → `queued → processing` → handler → terminal write + `event_attempts` row, all org-scoped. Anything that only changes DB state therefore composes safely with an in-flight pipeline — the guarded claim is the universal veto.
- BullMQ shapes the queue: **one job per (organization, employee)** (`jobId = org|employee`, both percent-encoded and `|`-joined), `removeOnComplete`/`removeOnFail: true`, and a `completed`-event relay in the processor that enqueues the next `received|queued` event by sequence. A `failed` row never has a live BullMQ job (its job was removed when it went terminal); a row mid-backoff **does** (its job sits in delayed state and its attempt counter keeps advancing).
- Attempt numbering today comes from BullMQ: `attempt = job.attemptsMade + 1` inside `process()`, `finalAttempt = job.attemptsMade` in the `failed` event handler. A **fresh** job restarts that counter at 0 — which is exactly what a manual retry would produce, and exactly what would collide with the existing `UNIQUE (event_id, attempt_number)` trail (transient create swallowed, exhaustion upsert clobbering the previous round's `failedReason`).
- The events module owns every read path with `organizationId` as the first argument of every public method; the global `HttpExceptionFilter` shapes any thrown `HttpException` (so `ConflictException` → the documented error body with no new plumbing).
- `events-list-api` (roadmap item 1, planned first) introduces `GET /events` with a status filter; the dead-letter view is a consumer of that contract, not a new endpoint.

## Goals / Non-Goals

**Goals:** manual actions that compose with the automated lifecycle instead of racing it; an append-only audit trail and attempt numbering that stay truthful across rounds; cancellation that costs no new worker machinery; a UI in which recovery is one obvious action away from any failure.

**Non-Goals:** BullMQ-side DLQ infrastructure; an API for reading the action audit (the table is written this change; a viewer is later work); role restriction of actions; idempotency-key replay semantics for actions; changes to automatic retry budgets or backoff.

## Decisions

### D1 — `CANCELLED` is a new terminal status, not a `FAILED` flavor

Add `CANCELLED` to the `EventStatus` enum (migration: `ALTER TYPE "EventStatus" ADD VALUE 'CANCELLED'` — Postgres 16 permits this inside the migration transaction as long as the value is not used in that same transaction). Rationale: reusing `FAILED` + a synthetic error type would make the documented invariant "`failed` implies at least one FAILED attempt" false and force carve-outs in the status contract, the filter vocabulary, and the UI badges. Reliability: keeps the guarded-lifecycle model (R5) — `cancelled` is just another terminal state the claim guard already treats as "not claimable".

**Alternative — `FAILED` with `errorType=CANCELLED`:** rejected for the conflation above; it also reads as a provider verdict, which a human action is not.

### D2 — Actions live beside the reads: a dedicated `EventRecoveryService` in the events module

Files created: `packages/core/src/events/event-recovery.service.ts`, `packages/core/src/events/dto/event-action-response.dto.ts`. Files modified: `packages/core/src/events/events.controller.ts` (`POST /events/:id/retry`, `POST /events/:id/cancel` — Swagger-annotated like every operation), `packages/core/src/events/events.module.ts` (provider), `packages/core/src/events/events.controller.spec.ts`. The service keeps the established convention — `organizationId` is the first parameter of every public method, `@CurrentActor()` supplies it, the actor id rides along for the audit for D6. Rejections throw `NotFoundException` / `ConflictException` and the existing `HttpExceptionFilter` shapes the body; no filter change. Reliability: tenant scoping (tenancy design D2/D3 discipline), reusable across API and worker processes.

**Alternative — methods on `EventsService`:** rejected; that service is submission-shaped (`createEvent`/`getEventStatus`) and is growing a third concern after `events-list-api` adds its query service. Recovery has its own transaction shape and audit, and a separate unit spec file keeps it honest.

**Alternative — `queue.remove(jobId)` on cancel:** rejected. The jobId is per-employee, not per-event: removing it could kill an *unrelated* in-flight event's job. The claim guard makes any stale job a no-op for free (R5), and because a skipped job still completes normally, the `completed` relay drains the employee's remaining chain as if the cancelled event had finished.

### D3 — Retry = guarded `failed → queued` transaction + best-effort enqueue after commit

`retryEvent(tenant, id, actor)` opens one transaction that (1) reads `MAX(attempt_number)` for the event from `event_attempts` (served by the existing `UNIQUE (event_id, attempt_number)` index — no new index), then (2) runs a guarded `updateMany({ where: { id, organizationId, status: FAILED }, data: { status: QUEUED, attempt_base: <that max> } })`. `count === 0` → `ConflictException` (concurrent retries/cancels lose atomically; R5's guarded-transition model). After commit, enqueue through the existing `PayrollEventQueueService` and post-commit relay, never blocking the response. The enqueue path is unified: `PayrollEventQueueService` gains `enqueueBestEffort(input)` (moves the 2-second wall-clock race out of `EventsService`'s private helper — `events.service.ts` is refactored to call it, so submission and retry share one "Redis-down never fails the action" behavior). Reliability: R2's best-effort enqueue discipline, R6's per-employee chain (a retried event is suppressed while an earlier job is in flight and is relayed in sequence order afterwards — no new schedulers).

### D4 — Attempt numbers ride job data as `attemptBase`, not row arithmetic

Root cause: `attemptsMade` is BullMQ-job-relative, but the audit trail is per-event. The fix keeps each numbering source where it lives:

- **New column** `payroll_events.attempt_base INTEGER NOT NULL DEFAULT 0` — "attempts already recorded before this event's next processing round". Written only by the retry transition (D3); real rounds (submission, relay) never touch it.
- **Job data gains `attemptBase?: number`** on `PayrollEventJobInput` (`packages/core/src/queue/payroll-event-queue.service.ts`). The producer sets it from the caller: submission passes nothing (`0`), the retry action passes nothing (its add only wins when no older job exists, and a fresh job must start from the persisted base — but it reads the base via the worker, below), and the **relay** passes the row's `attempt_base` (it already selects the row; the select gains the column).
- **Worker arithmetic** (`payroll-event.processor.ts`): in-flight attempt = `(job.data.attemptBase ?? 0) + attemptsMade + 1` (matches today's formula when base is 0); exhausted-final in `onFailed` = `(job.data.attemptBase ?? 0) + attemptsMade`. The `EventClaim` input contract is unchanged — it keeps receiving the final 1-based number.

Why row-based or read-MAX-per-attempt schemes were rejected: a continuing backoff job must **not** add a freshly written base (it would double-count its own round), and `MAX(attempt_number)+1` per attempt is a read-modify-write race against the exhaustion upsert. Job-data `attemptBase` is decided once per add: a continuing job keeps its original data (numbering continues naturally, no double-count), a fresh job starts from the persisted base exactly once. Reliability: R5 (exactly-once terminal writes — the audit stays append-only and collision-free), R7 unchanged. The UNIQUE constraint remains the backstop: a collision can only mean the known swallowed-recording edge (see Risks).

### D5 — Cancel = one guarded transaction `received|queued → cancelled`, nothing else

`cancelEvent(tenant, id, actor)` runs the guarded transition (count 0 → `ConflictException`) and writes the audit row (D6) in the same transaction. No BullMQ interaction, no attempt rows — the cancel committed and any job still holding the event is neutralized by the claim guard (D2's alternative section). `CANCELLED` is deliberately un-retryable and un-cancellable (guards reject; see spec). Reliability: R4's crash-safety model is untouched (no new transitions inside the claim), R5's guarded writes. The mid-backoff cancellation case — the highest-value one — needs zero extra code: the row is `queued` between attempts, so the same guard catches it.

### D6 — Audit: append-only `event_actions` written atomically with the transition

New model in `packages/database/prisma/schema.prisma`:

- `EventAction`: `id` (uuid PK), `event_id` (FK → `payroll_events`, `onDelete: Cascade`), `action` (new enum `EventActionType`: `RETRY | CANCEL`), `user_id` (plain `String`, **no relation** — a snapshot of who acted that survives user deletion, matching audit-table convention), `created_at`. Index `@@index([eventId])`.
- Scope inheritance via the FK, matching the `event_attempts` design decision deliberately (every write reaches this table through an event id a previous statement already tenant-validated).
- Append-only: rows are never updated or deleted; each action's row is created **inside the same transaction** as its guarded transition (the same atomicity D1 of the worker-recovery change gave `event_attempts`), so an audit row never exists for an action that did not happen, and vice versa. No endpoint reads this table in this change.

**Alternative — `CANCELLED` rows in `event_attempts`:** rejected; attempts are processing rounds, and the UI's attempt-count badge would learn to ignore rows. **Alternative — log-only:** rejected; an audit that survives neither restarts nor an operator question is not an audit.

### D7 — API contract: thin action responses, rich errors

`EventActionResponseDto` carries `id`, `status`, `eventType`, `employeeId` — the exact fields the UI needs to update a row without a refetch. Errors are the existing `ErrorResponseDto` via the global filter: `401` (global guard), `404` (unknown or foreign event), `409` (guard mismatch). Route order needs no care: `POST /events/:id/retry|:id/cancel` cannot shadow `GET /events/:id`. The `api-docs` e2e asserts get their new operation coverage as part of the suite update (tasks section). Reliability: asserts the tenancy contract at the boundary — every action is org-scoped, foreign events read as `404`.

### D8 — Frontend: actions inline, dead letters one view away

Modified: `apps/web/src/api/events.ts` (`retryEvent`, `cancelEvent` on the authed client), `apps/web/src/lib/status.ts` + `apps/web/src/components/StatusBadge.tsx` (`cancelled` badge), `apps/web/src/components/EventList.tsx` (row actions: retry on `failed`, cancel on `queued`/`received`, confirm-before-send, 409 → show error + per-row refetch). Created: `apps/web/src/lib/useRecovery.ts` (action calls + row refresh + poll-resume wiring — a failed row that is successfully retried re-enters the existing per-row poll loop; no new polling engine), `apps/web/src/components/DeadLetterView.tsx` (server-driven list via `GET /events?status=failed`, reusing the pagination hook `events-list-api` introduces; retry + detail access per row; explicit empty state), and `apps/web/src/App.tsx` gains the view wiring. The history hook from `events-list-api` remains the single list implementation; the dead-letter view is a filtered consumer of it, so there is exactly one way the UI browses events. Polling stays on `GET /events/{id}` per row — unchanged behavior, one more re-entry trigger.

## Risks / Trade-offs

- **`attempt_base` can lag if a transient-row recording was swallowed** (existing best-effort `recordTransientAttempt` catch) → the next round's first attempt collides on the UNIQUE key and its row is swallowed (logged); numbering resumes one-higher. Bounded, audit-visible via logs, and the exhaustion upsert still lands. Accepted.
- **Retry grants out-of-order processing** (an older event lands after newer ones succeeded) → inherent to retry-after-failure; safe until business effects exist, and `domain-effects` (roadmap 4) owns effective-dating. The spec states the resumed-turn semantics explicitly.
- **_deploy ordering with the enum value** — rolling back the code after `CANCELLED` rows exist leaves rows the old enum cannot read → rollback doc: enum value keeps old binaries erroring only on those rows; coordinate rollback with a data note or tolerate read-only staleness.
- **A UI action racing a lifecycle change** (row flips before the call lands) → `409` + client-side per-row refetch (D8); the server transition remains the only authority.
- **Extra read of `MAX(attempt_number)` per retry** → served by the composite unique index over a tiny per-event trail; negligible.

## Migration Plan

1. Prisma migration (additive): enum value, `attempt_base` column, `event_actions` table + index — ships before any code that writes `CANCELLED`.
2. Backend: queue service (`attemptBase`, `enqueueBestEffort`), processor arithmetic, recovery service + routes + DTOs, unit specs alongside each.
3. e2e: `apps/api/test/event-recovery.e2e-spec.ts` (fixtures via the documented `EMP-DEMO-*` forced-outcome employees) + `api-docs` contract additions.
4. Web: client, badge, actions, dead-letter view, Vitest coverage.
5. Docs: README API rows, `docs/architecture.md` component notes.

**Rollback:** schema change is additive; reverting the branch removes the UI and endpoints. Rows in `CANCELLED` must be reset (`UPDATE … SET status='FAILED'`) before restoring a pre-enum binary — called out in the runbook line, expected to be near-empty in practice.

## Open Questions

None blocking. The one deferred detail — whether the dead-letter view gets its own URL route or shares the history page as a filter preset — follows whatever `events-list-api` ships for routing; either satisfies the spec.
