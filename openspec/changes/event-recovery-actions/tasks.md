# Tasks

Implements `event-recovery` (new) and the `event-status-api`, `events-query-api`, `frontend-app` deltas. Design decisions D1–D8 referenced per task ⚠️ = reliability-critical path.

## 1. Schema foundation (D1, D4, D6)

- [x] 1.1 Additive Prisma migration in `packages/database/prisma/schema.prisma`: `EventStatus.CANCELLED` enum value, `PayrollEvent.attempt_base Integer @default(0) @map("attempt_base")`, new `EventActionType` enum (`RETRY`, `CANCEL`) and append-only `EventAction` model (`id`, `event_id` FK cascade, `action`, `user_id` — no relation, `created_at`, `@@index([eventId])`); generate the migration in `packages/database/prisma/migrations/` and verify it applies against the scratch database (`pnpm --filter @repo/database exec prisma migrate dev`) and `prisma generate` compiles the new client types
- [x] 1.2 Extend the recovery-relevant e2e schema coverage: add the cancelled/lifecycle assertions to `apps/api/test/recovery-schema.e2e-spec.ts` ( cancelled rows read back as `CANCELLED`; `event_actions` rows exist only when written) and verify the suite passes against real Postgres

## 2. Attempt-numbering + queue plumbing ⚠️ (D3, D4)

- [x] 2.1 `packages/core/src/queue/payroll-event-queue.service.ts`: add optional `attemptBase?: number` to `PayrollEventJobInput` (it flows into job data) and an `enqueueBestEffort(input)` method that wraps `enqueue` in the existing 2-second wall-clock race; refactor `packages/core/src/events/events.service.ts` to call it and delete its private `enqueueBestEffort`/`enqueueTimeout` duplicates; verify with the updated `payroll-event-queue.service.spec.ts` (attemptBase lands in job data; the timeout path rejects without throwing out of the caller) and `events.service.spec.ts` (submission still never fails the 201 when enqueue times out) — **reliability-critical: R2 best-effort enqueue, R6 per-employee job id unchanged**
- [x] 2.2 `packages/core/src/worker/payroll-event.processor.ts` numbering: effective attempt = `(job.data.attemptBase ?? 0) + (job.attemptsMade ?? 0) + 1` in `process()`, and exhausted-final = `(job.data.attemptBase ?? 0) + job.attemptsMade` in `onFailed`; the relay's `relayNextPending` select gains `attempt_base` and passes it as `attemptBase`; verify with new `payroll-event.processor.spec.ts` cases — continuing backoff job (base 0, `attemptsMade` 1–5 → rows 1–5), fresh job with `attemptBase: 5` (→ rows 6+), relay carries a non-zero base — **reliability-critical: R5 append-only audit, no collision or clobber**
- [x] 2.3 Verify the `EventClaim` contract still holds unchanged (input receives the final 1-based number; transient re-throw still aborts to `queued`) — run `event-claim.spec.ts` + the full `packages/core` unit suite and fix only arithmetic comments; **reliability-critical: R5 guarded claim must be untouched by this change**

## 3. Recovery service, routes, DTOs (D2, D3, D5, D6, D7)

- [x] 3.1 Create `packages/core/src/events/dto/event-action-response.dto.ts` (`id`, `status`, `eventType`, `employeeId`) with class-validator/Swagger annotations and verify it compiles into the Swagger document build
- [x] 3.2 Create `packages/core/src/events/event-recovery.service.ts` with `retryEvent(organizationId, id, actor)`: one transaction — read `MAX(attempt_number)` for the event, guarded `updateMany` `failed → queued` with `attempt_base` set (`count === 0` → `ConflictException`), `EventAction(RETRY)` row in the same tx — then best-effort enqueue of 2.1 after commit; unit spec `event-recovery.service.spec.ts` covering: 200+queued with updated numbering base, 409 on queued/success/cancelled/received rows, 404 on unknown and foreign-org ids, atomic audit row on success and **no** audit row on 409/404 — **reliability-critical: R5 guarded transition, audit atomicity**
- [x] 3.3 Add `cancelEvent(organizationId, id, actor)` to the same service: one transaction — guarded `received|queued → cancelled` (`count === 0` → `ConflictException`), `EventAction(CANCEL)` row; no attempt rows, no queue calls; extend `event-recovery.service.spec.ts` for both source states, 409 on terminal states, double-cancel 409, foreign/unknown 404 — **reliability-critical: R5/R4 transition guards**
- [x] 3.4 Extend `packages/core/src/events/events.controller.ts` with `POST /events/:id/retry` and `POST /events/:id/cancel` (`@CurrentActor()`, Swagger: bearer, typed 200 `EventActionResponseDto`, 404/401, 409 via `@ApiResponse`), wire the provider into `events.module.ts`, and extend `events.controller.spec.ts` (status codes, tenant propagation, actor id passed through)

## 4. e2e: recovery endpoints + API contract (D7 + spec scenarios)

- [x] 4.1 Create `apps/api/test/event-recovery.e2e-spec.ts` using real Postgres/Redis and the `EMP-DEMO-*` forced-outcome employees: (a) submit `EMP-DEMO-PERMANENT` → `failed` → retry → new round runs and the trail numbers continue (attempt 2 row, attempt-1 row unchanged); (b) submit `EMP-DEMO-TRANSIENT` with a reduced `PAYROLL_MAX_RETRY_ATTEMPTS` budget → exhausted → retry → numbering continues after exhaustion (rows 1..N, then N+1); (c) cancel a queued event before the worker claims it → status `cancelled`, no attempts, queued-badge scenarios; (d) cancel while an automatic backoff round is pending (`EMP-DEMO-TRANSIENT`) → the delayed retry completes without processing; (e) employee chain continuity — cancel seq 1, verify seq 2 still processes; (f) all 401/404/409 shapes including cross-org 404 and concurrent-retry single-winner; (g) `event_actions` rows exist exactly for effective actions
- [x] 4.2 Extend `apps/api/test/api-docs.e2e-spec.ts` for the two new operations (bearer requirement, documented 200/404/409) and run the whole `apps/api` e2e suite (`turbo run test:e2e --filter=apps-api`) — all green including the existing suites, proving no regression to submission/queue/status/idempotency

## 5. Frontend recovery surfaces (D8)

- [x] 5.1 Extend `apps/web/src/api/events.ts` with `retryEvent(id)` / `cancelEvent(id)` on the authenticated client (no Idempotency-Key header) and extend `apps/web/src/api/events.test.ts`
- [x] 5.2 Add the `cancelled` lifecycle mapping in `apps/web/src/lib/status.ts` + a cancelled variant in `apps/web/src/components/StatusBadge.tsx`, with updated `lib/status.test.ts` / badge test
- [x] 5.3 Create `apps/web/src/lib/useRecovery.ts` (confirm-guarded retry/cancel calls, per-row refetch on failure, poll re-entry for a retried row) and update `apps/web/src/components/EventList.tsx` to offer retry on failed rows, cancel on queued/received rows, and surface 409 messages; Vitest in `useRecovery.test.ts` + `EventList.test.tsx` (actions per status, no actions on terminal rows, 409 → error + refetch, poll resumes after retry)
- [x] 5.4 Create `apps/web/src/components/DeadLetterView.tsx` (failed-only selection via the events-query contract, attempt count + detail access + retry per row, explicit empty state) and wire the view/tab into `apps/web/src/App.tsx`; Vitest in `DeadLetterView.test.tsx` + `App.test.tsx` (fixtures: the forced-outcome demo employees against the running local stack)

## 6. Integration + docs

- [x] 6.1 Update `README.md` (API surface rows for the two actions + cancelled status) and `docs/architecture.md` (recovery path in the component map); verify the documented endpoints exist in `GET /api-docs-json`
- [x] 6.2 Run the full verification gate: `turbo run lint typecheck build test` across the workspace plus the e2e suite — all green; smoke the demo lifecycle end-to-end against `docker compose up` (submit `EMP-DEMO-PERMANENT` → cancel a queued `EMP-DEMO-SUCCESS` → dead-letter retry) — **reliability-critical regression gate**

## Workflow follow-up

- Update `openspec_roadmap.md`: mark feature-queue item 2 `event-recovery-actions` ✅ Done after review.
- If `events-list-api` has not been archived yet when this change is reviewed, sync/archive it first — this change's `events-query-api` delta assumes that capability exists in the main specs.
- The known `event-processing` spec drift (rows now recorded for every attempt) predates this change and stays owned by roadmap item 12 (`spec-sync`).
