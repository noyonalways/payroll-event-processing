## 1. Dependencies & Queue Module

- [x] 1.1 Install `@nestjs/bullmq@^11` and `bullmq@^5` as runtime dependencies (the worker and prod API prune dev deps); confirm `npm ls bullmq @nestjs/bullmq ioredis` resolves peers.
- [x] 1.2 Add `src/queue/queue.constants.ts` — `PAYROLL_EVENTS_QUEUE = 'payroll-events'`, `PAYROLL_EVENT_JOB = 'process'`.
- [x] 1.3 Add `src/queue/queue.module.ts` — `BullModule.forRootAsync` reading `REDIS_HOST`/`REDIS_PORT` from `ConfigService`, plus `BullModule.registerQueue({ name: PAYROLL_EVENTS_QUEUE })`.
- [x] 1.4 Add `src/queue/payroll-event-queue.service.ts` — `enqueue({ id, eventType, employeeId, sequence })` calling `queue.add(PAYROLL_EVENT_JOB, data, { jobId: employeeId, attempts: 1, removeOnComplete: true, removeOnFail: true })`.

## 2. Enqueue on Event Creation (API)

- [x] 2.1 **(reliability-critical)** Inject `PayrollEventQueueService` into `EventsService`; in `insertEvent`, immediately after the persist transaction commits: (a) guarded `UPDATE … SET status='queued' WHERE id=? AND status='received'`, (b) best-effort `enqueue(...)` inside its own try/catch that logs with context and never throws. `201 { id, status: 'received' }` response stays exactly as today.
- [x] 2.2 Import `QueueModule` in `src/events/events.module.ts`.
- [x] 2.3 Import `QueueModule` in `src/app.module.ts`.
- [x] 2.4 **(reliability-critical, test alongside)** Unit-test `EventsService.createEvent` with a mocked queue service: returns `201` + calls `enqueue` with `eventId`/`employeeId`/`sequence`; a rejected enqueue (Redis down) still returns `201` and persists the row; a duplicate `Idempotency-Key` re-submit does NOT call `enqueue`.

## 3. Worker Consumer & FIFO Relay

- [x] 3.1 **(reliability-critical)** Add `apps/worker/src/payroll-event.processor.ts` — `@Processor(PAYROLL_EVENTS_QUEUE)` extending `WorkerHost`; `process(job)`: guarded `received → queued` (no-op if already queued), guarded `queued → processing` (0 rows → log + return, no side effects), structured log (`eventId`, `employeeId`, `eventType`, `sequence`, `attempt=1`, worker pid), guarded `processing → success` with `processed_at = now()`.
- [x] 3.2 **(reliability-critical)** Add the FIFO relay in the processor: after the terminal update, query the next non-terminal row (`status IN ('received','queued')`, `id != current`, same `employeeId`) ordered by `sequence ASC`; `add` it with `jobId = employeeId` (a suppressed add is a no-op, never a duplicate).
- [x] 3.3 Wire `WorkerModule` — import `QueueModule`, declare `PayrollEventProcessor` (PrismaModule already imported).
- [x] 3.4 Update `apps/worker/src/main.ts` — remove the "consumers registered later" placeholder comment; the real WorkerHost consumer now bootstraps with the module.
- [x] 3.5 **(test alongside)** Unit-test the processor with a mocked PrismaService: claim succeeds for `queued`; stale job (row not `queued`) applies no state change; relay selects the next `sequence` and skips terminal rows; relay suppresses duplicate `jobId` adds.

## 4. Verification & Tests

- [x] 4.1 **(test alongside)** Integration/e2e with Postgres + Redis up: submit → row `queued` → worker claims → `success` with `processed_at`; a burst of N submissions for one employee is drained sequentially to `success` in `sequence` order.
- [x] 4.2 **(reliability-critical, test alongside)** e2e with Redis unavailable during submission: `POST /events` still returns `201 { id, status: 'received' }`, the row is persisted, and no error surfaces; re-submit with the same `Idempotency-Key` returns the stored response and does not enqueue a duplicate.
- [x] 4.3 Existing suites stay green: `npm run test`, `npm run test:e2e` (event-submission + api-docs + the two new queue suites, via `maxWorkers: 1` in `test/jest-e2e.json` since every DB-writing e2e suite shares one Postgres), `npm run build`, `nest build worker`, `npm run lint:check`.
- [x] 4.4 Manual `docker compose up` (API + worker + Postgres + Redis): /health `ok`; submit two events for one employee and one for another; worker logs show claim/complete per job; all three rows end `success` with `processed_at`; second same-employee event processed strictly after the first.