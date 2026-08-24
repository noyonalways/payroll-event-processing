## Context

An accepted event is currently persisted in `payroll_events` (`status = 'received'`, with `response_status`/`response_body`), and `POST /events` returns `201 { id, status: 'received' }` — but nothing consumes the event afterwards. There is no queue, no producer hook, and the `apps/worker` entrypoint is a placeholder that only logs "not wired yet".

This change adds the BullMQ transport between the API and the worker that the rest of the roadmap (#4 simulated provider/handlers, #5 retry/dead-letter, #7 locking/recovery) plugs into. Scope is deliberately queue mechanics only.

**Verified environment facts:**
- `Prisma.schema` already declares the full `EventStatus` enum (`RECEIVED | QUEUED | PROCESSING | SUCCESS | FAILED`) and `processed_at` — **no schema migration is required** by this change; we use existing columns/enum values.
- NestJS is 11; the queue wrapper `@nestjs/bullmq@^11` (BullMQ 5.x) is the current drop-in (`BullModule.forRoot` / `registerQueue` / `@Processor`+`WorkerHost` / `@InjectQueue`). `bullmq@^5` brings its own Redis driver (`ioredis`); the existing `redis` package keeps owning the `/health` deep check — two clients on the same Redis instance is normal (BullMQ namespaces its keys).
- `REDIS_HOST` / `REDIS_PORT` already exist in both the API and worker Joi schemas — no new env vars.
- `EventStatus.PROCESSING` / `SUCCESS` / `FAILED` are declared but never written today. This change starts writing `QUEUED`, `PROCESSING`, `SUCCESS` under guarded transitions.

## Goals / Non-Goals

**Goals:**
- A `payroll-events` BullMQ queue with per-employee FIFO ordering and parallelism across employees.
- Enqueue on event creation — after the persist transaction commits, best-effort and never blocking/failing the HTTP `201`.
- A real consumer in `apps/worker` that claims jobs, transitions the DB row through `queued → processing → success`, logs each job, and relays the next event for the same employee so nothing is stranded when a producer `add` is suppressed by an in-flight job.
- Queue-availability resilience: a Redis blip during submission must not reject or lose an event.

**Non-Goals:**
- Provider invocation, handler registry, attempt history — change #4.
- Retry/backoff/dead-letter, `attempts > 1` — change #5.
- `SELECT … FOR UPDATE SKIP LOCKED`, stalled-job tuning, exactly-once transactional commit — change #7.
- A sweeper for orphaned rows (a #7 follow-up; the drain covers the normal path).
- Status/read API (`GET /events`) — change #8.

## Decisions

### D1 — Dependencies: `@nestjs/bullmq@^11` + `bullmq@^5`, existing `redis` untouched
Add as runtime deps (the worker image and `npm prune --omit=dev` need them).
**Reliability:** none directly — foundational install.
**Alternatives considered:** hand-rolling a raw Redis consumer (re-implements FIFO, stalled recovery, retries — wrong); switching the health check to `ioredis` (unnecessary churn, two transports is fine since BullMQ namespaces its keys).

### D2 — Per-employee FIFO via `jobId = employeeId` + Postgres-driven drain (orders R6, recovers R2/R4)
BullMQ serializes jobs by id: `add(name, data, { jobId })` with an existing `jobId` is **silently ignored** — so there is at most **one in-flight job per employee** at a time, and different employees' jobs run in parallel. But that same suppression would *drop* a legitimately distinct event if the producer only ever `add`s. The fix is to make the **DB row the source of truth** and recover from it:

- Producer: after commit, `add` the job AND flip the row `received → queued` (guarded, best-effort — D3).
- Worker: after each job completes, **drain** the employee — query the next **non-terminal** row for `employeeId` with the smallest `sequence` (status in `received|queued`, `id != current`), and `add` it with `jobId = employeeId`. That `add` either lands a live job (Redis was reachable / job gone) or is suppressed (a newer live job already covers the employee) — either way the event is not lost.
- Consequently the recovery net is the **`sequence` ordering + the `queued`/`received` statuses**, not Redis job retention. `removeOnComplete`/`removeOnFail` are irrelevant to correctness.

**Reliability:** R6 (per-employee ordering, parallel across employees), R2 backstop (drain never duplicates), R4 partial (a suppressed `add` is recovered).
**Alternatives considered:** a queue per employee (too many queue keys + BullMQ overhead per queue), a shared `lockKey`/flow-producer (more moving parts than a durably-stored drain), or relying on `removeOnComplete` retention for idempotent re-add (breaks: non-removed completed jobs block `jobId` reuse — see D5 rationale).

### D3 — Enqueue hook: post-commit, best-effort, guaranteed non-blocking (R2)
In `EventsService.insertEvent`, immediately after `await this.prisma.$transaction(...)` resolves and **before** `return { httpStatus, body }`:

1. `await queueService.enqueue({ id, eventType, employeeId, sequence })` wrapped in its own `try/catch` — failures are logged with full context, never propagated.
2. Guarded transition: `UPDATE payroll_events SET status='queued' WHERE id=? AND status='received'` (idempotent; `0` rows = already queued by a relay — fine).

Order matters: mark `queued` *then* `add`, so the row is always discoverable by the drain even when the `add` is suppressed by an in-flight `jobId`. If the `add` **rejects** (Redis down), the row stays `received` — never a client-facing error; `201` is returned and the row is recovered by the employee's next drain once Redis is reachable (D5 risk note).

**Reliability:** the idempotency guarantee (R2) must not depend on queue state — the stored `201` response is unaffected by enqueue success/failure.
**Alternatives considered:** enqueue inside the DB transaction (mixes a network RPC into a DB tx — rolls back bad state on Redis hiccup and ties `201` latency to Redis); a transaction-outbox table (right long-term answer, deliberately out of scope — the drain already provides at-least-once via Postgres).

### D4 — Worker claim/terminal transitions, guarded, non-transactional for now (R4/R5 scaffolding, boundaries to #7)
`apps/worker/src/payroll-event.processor.ts`, `@Processor('payroll-events')`, extends `WorkerHost`, implements `process(job)`:

1. **Claim** (two idempotent guarded updates, each matching 0 or 1 rows):
   - `UPDATE … SET status='queued' WHERE id=? AND status='received'` (relayed rows may still be `received`; no-op otherwise).
   - `UPDATE … SET status='processing' WHERE id=? AND status='queued'` — **`0` rows → stale/duplicate job**: log and `return` without re-adding (never re-process).
2. **Process step (this change):** structured log — `eventId`, `employeeId`, `eventType`, `sequence`, `attempt=1`, worker pid. (Provider call/handler dispatch = #4.)
3. **Terminal:** `UPDATE … SET status='success', processed_at=now() WHERE id=? AND status='processing'`.
4. **Drain** (D2), hooked to the BullMQ `completed` event — **not** at the tail of `process()`: while `process()` runs the current job is still *active*, so an `add` with the same `jobId = employeeId` would be suppressed by its own key. `handleCompleted` runs `job.moveToCompleted(...)` first (which frees the key via `removeOnComplete: true`) and emits `completed` only afterwards, so the drain runs exactly when the jobId is free and its `add` lands. Wired via `@OnWorkerEvent('completed')`.

Not wrapped in a transaction; the claim guard already prevents *double success-application* for the common reprocess-after-success case (a re-run's `queued → processing` matches 0 rows). Full crash-recovery semantics (stalled detection, re-claim of `processing` rows, transactional exactly-once commit) are explicitly #7 — documented in Risks.

**Reliability:** R4 partial (side-effect marker `processing` set before work), R5 partial (status-guarded terminal write).
**Alternatives considered:** moving the terminal write into a `$transaction` now — deferred to #7 where the lock/attempt/result are added, to keep this change mechanically minimal.

### D5 — Queue job config: `attempts: 1`, `removeOnComplete: true`, `removeOnFail: true`
- `attempts: 1`: there is no retry strategy yet — that's #5. A failed processing step surfaces as a failed job and the row stays `processing` (visible, inspectable).
- **Immediate removal** is required for the `jobId = employeeId` pattern: a retained completed job would block a later `add` with the same `jobId` (BullMQ duplicate detection sees it), starving the drain. Removing immediately keeps Redis bounded (architecture D3) and free for the next relay; correctness lives in the DB drain, not in job retention.
**Reliability:** R6 (not blocking the next relay), D3-boundedness.
**Alternatives considered:** `removeOnComplete: 1000` retention — breaks the FIFO relay (completed job would suppress the next `add`) — rejected for this pattern.

### D6 — Module wiring and shared queue token
- `src/queue/` module reused by **both** Nest applications (they are separate processes, each registers its own `forRoot` against the same Redis):
  - `src/queue/queue.constants.ts` — `PAYROLL_EVENTS_QUEUE = 'payroll-events'`, `PAYROLL_EVENT_JOB = 'process'`.
  - `src/queue/queue.module.ts` — `BullModule.forRootAsync` reading `REDIS_HOST`/`REDIS_PORT` from `ConfigService`, plus `BullModule.registerQueue({ name: PAYROLL_EVENTS_QUEUE })`; exports `PayrollEventQueueService` (which injects the queue via `@InjectQueue`).
  - `src/queue/payroll-event-queue.service.ts` — `enqueue({ id, eventType, employeeId, sequence })`.
- API side: `EventsModule` imports `QueueModule`; `EventsService` constructor gains `PayrollEventQueueService`.
- Worker side: `WorkerModule` imports `QueueModule` + `PrismaModule` (already) and declares `PayrollEventProcessor`; `main.ts` placeholder comment replaced by the real consumer.

**Files created:** `src/queue/queue.module.ts`, `src/queue/queue.constants.ts`, `src/queue/payroll-event-queue.service.ts`, `apps/worker/src/payroll-event.processor.ts`.
**Files modified:** `src/events/events.service.ts`, `src/events/events.module.ts`, `src/app.module.ts`, `apps/worker/src/worker.module.ts`, `apps/worker/src/main.ts`, `package.json`.
No `prisma/schema.prisma` or migration changes.

## Risks / Trade-offs

- **Redis unavailable at submit time** → the `add` rejects, row stays `received`, `201` still returned → [Mitigation] the row is recovered by the employee's next drain (the drain scans `received|queued`); a broad Redis outage stops all processing regardless of this change. A periodic sweeper for orphaned rows is listed as a #7 follow-up; log `ERROR` with eventId/employeeId when an enqueue fails so ops can see it.
- **Worker crashes mid-job** (`queued → processing` committed, terminal write not) → row left `processing`; the stalled job is re-queued by BullMQ defaults but the claim guard makes the re-run skip it → [Mitigation] documented non-goal: full stalled-job recovery flags it as `#7`. The common reprocess-after-success window is already safe via the claim guard (no double success-application).
- **Drain race between two workers for one employee** → both `add(jobId=employeeId)`; exactly one wins (jobId suppression), the other is a no-op; DB status guards prevent double-claims. Parallelism across different employees is preserved.
- **`removeOnComplete: true` means no job history in Redis** → intentional; the event row (`status` + `processed_at`) is the durable record; attempt-level history arrives in #4. Redis stays bounded.
- **Ordering guarantee is per-employee FIFO, not global** → by design (assignment R6).

## Migration Plan

- **Deploy:** `npm install @nestjs/bullmq bullmq`, build both `nest build`/`nest build worker`, ship API + worker images together. No schema/`prisma` step.
- **Rollback:** remove the `QueueModule` imports and the service hook; the API returns to persisting-only behavior. Events already marked `queued`/`processing`/`success` remain truthful terminal records; nothing is corrupted, and no queue data is lost (source of truth is Postgres).
- **Forward-compat:** the processor's contract (`{ eventId, employeeId, eventType, sequence }` job payload, guarded status transitions, drain) is exactly what #4/#5/#7 extend; no retraining of job format needed.

## Open Questions

None blocking. The only intentionally deferred item is the orphaned-`queued` sweeper (a #7 candidate), noted under Risks.