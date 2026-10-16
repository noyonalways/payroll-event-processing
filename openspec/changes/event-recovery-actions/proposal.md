# Proposal

## Why

The reliability automation is complete (automatic retries with backoff, exactly-once terminal writes, crash recovery), but its human counterpart is missing: a `failed` event is stuck forever — the simulated provider's transient/permanent failures mean exhaustion happens in normal operation, and no API or UI action can put it back in the pipeline. Symmetrically, a `queued` event that was submitted in error cannot be stopped before it processes. And because terminal failures are spread across history, nothing surfaces "what needs attention" in one place. This is roadmap feature-queue item 2; the query foundation it needs (`GET /events` with filters) is item 1 (`events-list-api`).

## What Changes

- **Recovery action `POST /events/:id/retry`** — puts a terminal `failed` event back on its per-employee processing chain: a guarded `failed → queued` transition plus a queue add (best-effort, like submission). Ineligible states (`queued`, `processing`, `success`, `cancelled`) are rejected with HTTP `409`, keeping the reprocess-never-twice guarantee (R5).
- **Recovery action `POST /events/:id/cancel`** — stops a pending event (`received` or `queued`) with a guarded transition to a new terminal status `CANCELLED`. Ineligible states (`processing`, `success`, `failed`, `cancelled`) are rejected with `409`.
- **New lifecycle status `CANCELLED`** — additive to the `EventStatus` enum and the status vocabulary of the status and list endpoints and the UI.
- **Attempt numbering that outlives a BullMQ job** — processing attempts are numbered across manual retry rounds (a new column records the attempt offset so the append-only `event_attempts` trail — one row per attempt, `UNIQUE (event_id, attempt_number)` — never collides or clobbers when a fresh BullMQ job restarts its counter at 1).
- **Manual-action audit trail** — a new append-only `event_actions` table records every effective recovery action (which action, which event, which user, when).
- **Worker interplay guarantees** — a job for a cancelled event is a no-op (the existing guarded claim already skips non-`queued` rows); a retried event rejoins the per-employee FIFO in sequence order among pending events, riding the existing in-flight-job suppression and the completed-relay drain (R6).
- **UI recovery surfaces** — per-row Retry (failed) / Cancel (queued or received) actions, a `cancelled` status badge, polling that resumes when a failed event is retried, and a **dead-letter view**: one server-driven page of failed events (via `GET /events?status=failed`) with their failure reasons, where recovery happens.

## Capabilities

### New Capabilities
- `event-recovery`: Manual lifecycle recovery over organization-scoped payroll events — retrying terminal failures, cancelling pending events, the transition guards and tenant scoping of those actions, the audit trail they append to, attempt-numbering continuity across retry rounds, and the guarantee that cancelled events are never processed.

### Modified Capabilities
- `event-status-api`: The status field of the event response can now report `cancelled` (a sixth lifecycle state); terminal-attempt consistency is stated for `success`/`failed` and explicitly absent for `cancelled`.
- `events-query-api`: The `status` filter vocabulary gains `cancelled`. (Capability is introduced by the queued `events-list-api` change; this delta assumes it is applied first, per roadmap order.)
- `frontend-app`: The events list gains per-row recovery actions (retry on failed rows, cancel on pending rows) and a `cancelled` badge; polling stops at `failed` but resumes when the user retries it; a dedicated dead-letter view lists failed events with their reasons and hosts the retry action.

## Non-goals

- **No new dead-letter queue infrastructure.** In this system "dead letter" means the set of terminal `failed` rows; the view reads `GET /events?status=failed` and no Redis-side DLQ is introduced.
- **No `Idempotency-Key` on action endpoints.** Repeating an already-applied action is rejected `409` by the transition guard — a stronger, self-describing answer than stored-response replay — and effective actions are audited.
- **No role-based action rights.** Any member of the organization may act; RBAC is roadmap item 7 (`role-enforcement`).
- **No strict global ordering for retried events.** A retried event resumes in sequence order among *pending* events; if newer events of the same employee already succeeded, it processes after them. Safe today (the simulated handler applies no business state); the real-effects change (`domain-effects`, item 4) owns effective-dating.
- **No change to automatic retry behaviour** — attempt budgets, backoff, and exhaustion handling stay exactly as the `retry-failure-handling` capability defines them.
- **No realtime push** — the dead-letter view polls, SSE is roadmap item 5.

## Impact

- **API**: two new authenticated operations on the events controller with `200`/`404`/`401`/`409` responses, Swagger-documented per `api-documentation`; the status vocabulary grows to include `cancelled`.
- **DB**: one additive migration — `EventStatus.CANCELLED` enum value, `attempt_base` column on `payroll_events` (default `0`), and the new append-only `event_actions` table. No existing data changes meaning; existing rows keep `attempt_base = 0`, matching today's numbering.
- **Code**: `@repo/core` events module (service + controller + DTOs), worker processor and `EventClaim` (attempt offset read), `apps/web` (`EventList` actions, `StatusBadge`, dead-letter view, `api/events.ts` client, `useEventTracker`), `@repo/shared` if an action/reason constant is shared.
- **Tests**: unit specs for the transition guards, numbering continuity, and claim/processor interplay; a new e2e suite covering both actions end-to-end (the `EMP-DEMO-*` forced-outcome levers provide reliable fixtures); contract checks in the existing `api-docs` e2e.
- **Docs**: README API surface and architecture component-map updates.
