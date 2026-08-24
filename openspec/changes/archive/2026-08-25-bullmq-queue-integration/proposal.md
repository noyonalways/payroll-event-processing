## Why

Today an accepted event is persisted (`status = 'received'`) and returned with a fast `201`, but nothing ever picks it up — the background worker doesn't exist. The assignment requires *"persist → enqueue → fast response"* with a separate worker processing events asynchronously. This change introduces the BullMQ queue, the producer hook that enqueues on submission, and the worker entrypoint that consumes jobs — the machine that later changes (#4 provider/handlers, #5 retry, #7 locks/recovery) plug into.

## What Changes

- **New `event-queue` capability**: BullMQ module wired to Redis, one `payroll-events` queue, per-employee FIFO semantics via `jobId = employeeId` (at most one in-flight job per employee; parallelism across employees).
- **Enqueue on event creation**: `EventsService.insertEvent` enqueues the freshly persisted event after its transaction commits (best-effort, never blocks or fails the HTTP response) and transitions the row `received → queued`.
- **Worker entrypoint** (`apps/worker`): consumes `payroll-events`, performs the guarded `queued → processing` claim and `processing → success` terminal transition (with `processed_at`), logs each job, and **relays** the next `queued` event for the same employee after a job completes so FIFO recovery never loses a submission when the producer's `add` was suppressed by an in-flight `jobId`.
- **Queue availability resilience**: Redis being down at submission time must not lose or reject an event — the persisted row is the source of truth and the worker's drain recovers it once the queue is reachable.

## Capabilities

### New Capabilities
- `event-queue`: BullMQ queue infrastructure, per-employee FIFO job naming, enqueue-on-create producer, worker consumer with claim/terminal transitions, basic job logging, and the drain/relay recovery path. Scoped to queue mechanics only — provider invocation, attempt history, retries, and row locks are later changes.

### Modified Capabilities
- `event-submission`: an event's DB `status` now transitions `received → queued` immediately after enqueue, while the HTTP submission contract stays exactly `201 { "id": ..., "status": "received" }` (the response reflects acknowledgement — the queue state is DB-internal). The persistence requirement (scenario "Row persisted with submission state") is extended so the row's `queued` transition is a defined behavior rather than a contradiction.

## Impact

- **New module**: `src/queue/` — `queue.module.ts` (`BullModule.forRoot` + `registerQueue('payroll-events')`), `payroll-event-queue.service.ts` (typed producer), `relay/drain` helper for the worker.
- **Modified**: `src/events/events.service.ts` (post-commit enqueue hook), `src/events/events.module.ts` (import `QueueModule`), `src/app.module.ts` (import `QueueModule` — Redis config already present via `REDIS_HOST`/`REDIS_PORT`), `apps/worker/src/worker.module.ts` (register queue + processor), `apps/worker/src/main.ts` (wiring comment replaced by real consumer).
- **New files**: `apps/worker/src/payroll-event.processor.ts` (`@Processor('payroll-events')` consumer).
- **Dependencies**: `@nestjs/bullmq@^11` + `bullmq@^5` (build alongside `ioredis` as BullMQ's driver). The existing `redis` package stays — it owns the `/health` deep check and is untouched. Two queue connections to the same Redis instance are fine (separate client namespaces).
- **Non-goals**: no simulated provider call or handler registry (#4), no retry/backoff/dead-letter (#5), no `event_attempts` writes (#4/#5), no `SELECT … FOR UPDATE`/stalled-job tuning/exactly-once commit (#7), no status/history read API (#8). The worker's `success` transition is a scaffolding terminal state so events don't pile up in `processing`; the real success semantics (provider result + attempt record) land in #4.