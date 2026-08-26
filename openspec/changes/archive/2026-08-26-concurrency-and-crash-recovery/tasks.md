## 1. Schema & Migration

- [x] 1.1 Add `AttemptStatus` and `AttemptErrorType` enums plus `EventAttempt` and `WorkerHeartbeat` models to `prisma/schema.prisma` (`@@map("event_attempts")` / `@@map("worker_heartbeats")`, `@@index([eventId])` on attempts, `workerId @id` PK on heartbeats) — additive, no existing-column changes
- [x] 1.2 Generate the migration (`npx prisma migrate dev --name worker_recovery_and_attempts`) and verify the SQL creates both tables and the attempts index with no changes to existing tables
- [x] 1.3 Write/extend integration coverage asserting the new tables exist with the expected columns and index (via `pg_indexes` / Prisma introspection in a real Postgres integration test)

## 2. Worker recovery configuration

- [x] 2.1 Create `src/queue/worker-options.ts` exporting `WORKER_OPTIONS` computed at module import (env frozen at import): `concurrency: 1`, `lockDuration` from `PAYROLL_WORKER_LOCK_DURATION_MS` (default 30000), `stalledInterval` from `PAYROLL_WORKER_STALLED_INTERVAL_MS` (default 30000), `maxStalledCount` from `PAYROLL_WORKER_MAX_STALLED_COUNT` (default 1)
- [x] 2.2 Apply `@Processor(PAYROLL_EVENTS_QUEUE, WORKER_OPTIONS)` to `PayrollEventProcessor` and verify the created BullMQ Worker receives the options (unit/integration assertion on `QueueEvents`/`Worker` construction)
- [x] 2.3 Add `PAYROLL_WORKER_LOCK_DURATION_MS`, `PAYROLL_WORKER_STALLED_INTERVAL_MS`, `PAYROLL_WORKER_MAX_STALLED_COUNT`, `WORKER_HEARTBEAT_INTERVAL_MS` to the worker Joi schema (`apps/worker/src/worker.module.ts`) and to `.env.example`, `.env.development`, `.env.test`, `.env.production`, and the api/worker `environment` blocks in `docker-compose.yml` / `docker-compose.override.yml` (top-level-priority pattern)
- [x] 2.4 Verify config loads in tests and containers (Joi defaults apply when unset; no missing-required-var startup failure for the worker or api)

## 3. Transactional processing lifecycle (reliability-critical: R3 concurrency, R4 crash recovery, R5 exactly-once)

- [x] 3.1 Implement `src/processing/event-claim.ts` (design D1): interactive `$transaction` (`{ timeout: 10_000, maxWait: 5_000 }`) that acquires `SELECT … FOR UPDATE` on the event row via `$queryRaw`, performs the guarded `queued→processing` claim (count 0 → skip with no side effects), reads the payload, dispatches the handler via the registry, and commits the guarded terminal write (`processing→success` + `result` + `processedAt`, or `processing→failed` for permanent errors) together with an `event_attempts` row; a `TransientPayrollFailureError` SHALL abort the transaction (rollback to `queued`), never an explicit reset — **write `event-claim.spec.ts` alongside** covering: claim-success commit order, stale/duplicate skip, transient rethrow with no reset update and no attempt row, permanent → failed + attempt row atomic, success → success + attempt row atomic, aborted/rejected transaction leaves the row claimable
- [x] 3.2 Refactor `apps/worker/src/payroll-event.processor.ts`: `process()` delegates the claim→dispatch→terminal lifecycle to `event-claim.ts`; keep the `received→queued` ensure before the transaction, the `@OnWorkerEvent('completed')` relay, the heartbeat `touch()`, and the structured `started` / `succeeded` / `retrying` / `permanent-failure` log lines — **update `payroll-event.processor.spec.ts`** to the transactional contract (transient no longer performs an explicit `processing→queued` reset)
- [x] 3.3 `onFailed` exhaustion path: wrap the existing `queued→failed` update **and** the `event_attempts` `FAILED(TEMPORARY, reason)` insert in one `$transaction` array (keeping the mid-retry `attemptsMade < maxAttempts` no-op guard) — update the processor spec to assert the attempt row on exhaustion

## 4. Worker heartbeats + /health liveness (reliability-critical: R4 observability)

- [x] 4.1 Implement `src/processing/heartbeat.service.ts`: `OnModuleInit` starts an unref'd `setInterval` at `WORKER_HEARTBEAT_INTERVAL_MS` (default 5000) upserting `workerId`/`hostname`/`startedAt`/`lastSeenAt` (workerId = `WORKER_ID` env or `${hostname}:${pid}`), `touch()` for immediate bumps, `OnModuleDestroy` clears the timer — **write `heartbeat.service.spec.ts`** (upsert shape, stale-aging source, timer lifecycle)
- [x] 4.2 Register `HeartbeatService` in `WorkerModule` and call `touch()` at the start of each `process()` invocation
- [x] 4.3 Extend `/health`: `HealthResponseDto` gains `workers: WorkerLivenessDto[]` (`workerId`, `hostname`, `lastSeenAt`, `stale`) and `stalled: number` (BullMQ `getJobCounts().stalled`); overall `status` SHALL be `degraded` when any worker is stale (`lastSeenAt` older than `HEALTH_WORKER_STALE_MS`, default 15000) or `stalled > 0`; add Swagger descriptions/examples — update `src/common/health/*` and its spec/e2e assertions
- [x] 4.4 Add `HEALTH_WORKER_STALE_MS` to the API Joi schema (`src/app.module.ts`) and to `.env.*` + compose `environment` blocks (worker heartbeat vars already covered by 2.3)

## 5. e2e, docs, and verification

- [x] 5.1 Update `test/processing.e2e-spec.ts`: transient failures now rely on transaction rollback (assert the row returns to `queued` between attempts is not required; keep the terminal `failed` assertions), and on exhaustion assert exactly one `event_attempts` row with `status FAILED` / `errorType TEMPORARY` / the final `attemptNumber`; the existing ~16 s retry cadence wall stays valid
- [x] 5.2 Update `test/event-queue.e2e-spec.ts` (always-success): assert the resulting `event_attempts` SUCCESS row carries the same `result` as the event row and `attemptNumber` 1
- [x] 5.3 Add/extend a health-check e2e (`test/health-check.e2e-spec.ts` or the existing health spec): `/health` returns `workers[]` and `stalled`, `degraded` when a worker's `lastSeenAt` is forced stale, and the OpenAPI JSON documents the extended `HealthResponseDto`
- [x] 5.4 Green pipeline: `npm run lint:check`, `npm test`, `npm run test:e2e` (Dockerized Postgres/Redis), and a manual smoke test against the compose stack (submit → duplicate → check `event_attempts` row + `/health` worker liveness)
- [x] 5.5 Update `docs/architecture.md` (D4/D5 now implemented, lifecycle semantics, `event_attempts`/`worker_heartbeats` tables) and mark roadmap row 7 done in `openspec_roadmap.md`

## 6. Cleanup & commit

- [x] 6.1 Grep for stale references to the old non-transactional claim model ("claim commits before work", explicit transient `processing→queued` reset comments, absent tables in docs) and remove/update
- [x] 6.2 Conventional commits per group (e.g. `feat(worker): transactional row-locked processing`, `feat(worker): stalled-job recovery settings`, `feat(health): worker liveness`) with the new tables called out in the migration commit — **left to the user** (per the no-commit directive: "no need commit I will commit.") — user committed as `38ab507`