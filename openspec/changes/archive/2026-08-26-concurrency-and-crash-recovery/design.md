# Design — concurrency-and-crash-recovery

## Context

The worker (`apps/worker/src/payroll-event.processor.ts`) already has guarded transitions: `received→queued` (ensure), `queued→processing` (claim), `processing→success` (with `result` + `processed_at`), `processing→failed`, and `processing→queued` (transient reset). Per-employee FIFO runs on `jobId = employeeId` with a completion relay (`@OnWorkerEvent('completed')`).

The gap this change closes, explicitly deferred by `bullmq-queue-integration` (its archived design: *"row left `processing`; stalled job re-queued but the claim guard makes the re-run skip it → full stalled-job recovery is #7"*):

1. **Crash between claim and terminal write** → the claim **committed** (`queued→processing`), the terminal write never ran; the row is stuck in `processing` forever. BullMQ re-queues the job, but the fresh attempt's `queued→processing` guard matches 0 rows → skip. **Event lost until manual intervention.**
2. **No DB row lock** (`SELECT … FOR UPDATE`) — concurrency safety rests on the queue only.
3. **No explicit BullMQ stalled-job settings** — defaults are guessed, not configured.
4. **No worker liveness in `/health`** — a dead worker is invisible (`worker_heartbeats` from architecture D4 never built).
5. **No attempt audit trail** — architecture D?/R5's `event_attempts` (append-only) never built; success is a lone guarded UPDATE.

The architecture document's **D4** (heartbeat table + `/health` deep check) and **D5** (interactive `$transaction` + `$queryRaw … FOR UPDATE`, guarded `UPDATE`, commit) are the canonical design targets for this change. **Constraint recall (memory `nestjs-config-snapshots-env-at-import`):** `@nestjs/config` freezes `process.env` at import; any env-dependent value must be read at module import time (which the `@Processor` decorator-meta approach below respects, and the e2e harness must set env before build).

## Goals / Non-Goals

**Goals:**
- Make a crash at **any point** between claim and terminal write recover automatically: the row is back in `queued`, BullMQ re-queues the stalled job, a fresh attempt reprocesses — exactly-once preserved (R4 + R5).
- Add a DB-level per-event row lock inside the processing transaction so even across multiple worker instances the same event is never processed concurrently (R3).
- Write the terminal `payroll_events` transition (`processing→success|failed`) and the `event_attempts` audit row **in the same committed transaction** (R5).
- Explicit, env-configurable BullMQ worker recovery settings (`lockDuration`, `stalledInterval`, `maxStalledCount`) (R4).
- Worker liveness in `/health`: `worker_heartbeats` staleness + BullMQ `stalled` count, `degraded` when either fires (R4 observability, D4).
- Keep the existing per-employee FIFO ordering, completion relay, and structured lifecycle logs intact.

**Non-Goals:**
- No `event_attempts` row per **transient retry** — transient attempts remain observable via the existing structured `retrying` log lines; the table records only attempt outcomes that commit a terminal state (success / failed). Writing a row inside the aborted retry transaction would roll it back anyway.
- No dead-letter table or DLQ — `failed` remains the terminal marker (existing behavior).
- No multi-worker autoscaling / Kubernetes / leader election — the design must be *safe* under N workers, not manage their lifecycle.
- No changes to the public REST contract; `/health` gains additive fields only.
- No `claimed_by_worker` column — with the transactional claim a committed `processing` state is impossible, so a recovery sweep based on claim ownership is unnecessary.

## Decisions

### D1 — Transactional processing lifecycle: one interactive `$transaction` with `SELECT … FOR UPDATE` (R3, R4, R5)

New repository `src/processing/event-claim.ts` exposing `claimAndProcess(…)`. Inside one interactive Prisma transaction (`{ timeout: 10_000, maxWait: 5_000 }`):

```ts
return this.prisma.$transaction(async (tx) => {
  // Row lock (R3) — D5's `$queryRaw` pattern; Prisma's builder has no FOR UPDATE.
  await tx.$queryRaw`SELECT id FROM payroll_events WHERE id = ${eventId} FOR UPDATE`;

  const claimed = await tx.payrollEvent.updateMany({          // guarded claim
    where: { id: eventId, status: EventStatus.QUEUED },
    data: { status: EventStatus.PROCESSING },
  });
  if (claimed.count === 0) return { outcome: 'skipped' };     // stale/duplicate, no side effects

  const row = await tx.payrollEvent.findUnique({ ... });      // payload read inside tx
  let result: ProcessingResult;
  try { result = await strategy.handle({ ... }); }
  catch (error) {
    if (error instanceof TransientPayrollFailureError) throw error;   // abort → claim rolls back to `queued`
    // permanent: commit failed + attempt row together
    await tx.payrollEvent.updateMany({ where: { id, status: PROCESSING }, data: { status: FAILED } });
    await tx.eventAttempt.create({ ... status: FAILED, errorType: 'PERMANENT', failedReason });
    return { outcome: 'permanent-failure' };
  }
  await tx.payrollEvent.updateMany({ where: { id, status: PROCESSING }, data: { status: SUCCESS, result, processedAt } });
  await tx.eventAttempt.create({ ... status: SUCCESS, result });
  return { outcome: 'success' };
}, { timeout: 10_000, maxWait: 5_000 });
```

**Why:** a crash at any point before `commit` aborts the transaction and Postgres rolls the claim back to `queued` — the exact stuck-row gap disappears at the source. Transient failure is *rollback*, not a `processing→queued` reset statement. BullMQ's re-queued job now finds the row claimable, so stalled-job recovery (below) actually completes. The terminal `payroll_events` write and the `event_attempts` append commit atomically (R5).
**Alternatives:** (a) keep two separate writes + a sweep that resets stale `processing` rows → sweep must distinguish "crash vs long-but-alive claim", needs a `claimed_by_worker` column and heartbeat plumbing just to be safe; the transactional design makes the window logically empty. (b) `SKIP LOCKED` on a "pick next pending row" claim → overkill; jobs already name their event by id, so a plain `FOR UPDATE` on one row is correct and simpler.

The contract change is **BREAKING** at the worker-internal level: `process()` no longer performs a separate committed claim; the transient path has no explicit reset (rely on rollback). The `received→queued` ensure stays a separate best-effort statement *before* the tx (a relayed job may still be `received`).

### D2 — `event_attempts` table: terminal-outcome audit trail (R5)

```prisma
enum AttemptStatus { SUCCESS FAILED }
enum AttemptErrorType { TEMPORARY PERMANENT }

model EventAttempt {
  id            String            @id @default(uuid())
  eventId       String            @map("event_id")
  attemptNumber Int               @map("attempt_number")
  status        AttemptStatus
  errorType     AttemptErrorType? @map("error_type")
  failedReason  String?           @map("failed_reason")
  result        Json?
  createdAt     DateTime          @default(now()) @map("created_at")

  @@index([eventId])
  @@map("event_attempts")
}
```

Rows are created **inside the terminating transaction only**: a `SUCCESS` row alongside `processing→success` (D1), a `FAILED(PERMANENT)` row alongside `processing→failed` (D1), and, for **retry exhaustion**, the `onFailed` hook wraps its existing `queued→failed` update **and** inserts `FAILED(TEMPORARY, reason)` in one small transaction:

```ts
await this.prisma.$transaction([
  this.prisma.payrollEvent.updateMany({ where: { id, status: QUEUED }, data: { status: FAILED } }),
  this.prisma.eventAttempt.create({ data: { eventId, attemptNumber: job.attemptsMade, status: 'FAILED', errorType: 'TEMPORARY', failedReason: error.message } }),
]);
```

**Why:** retries/deliverability are already deterministically observable through `attempt_number` in log lines; the table is the *terminal* audit record and stays append-only. Writing transient rows would either roll back (inside the aborted tx) or require a second non-atomic write.

### D3 — Explicit BullMQ worker recovery settings (R4)

```ts
// src/queue/worker-options.ts — env frozen at module import (see Context constraint)
export const WORKER_OPTIONS = {
  concurrency: 1,                                              // per-employee FIFO: one job at a time per worker
  lockDuration: Number(process.env.PAYROLL_WORKER_LOCK_DURATION_MS ?? 30_000),
  stalledInterval: Number(process.env.PAYROLL_WORKER_STALLED_INTERVAL_MS ?? 30_000),
  maxStalledCount: Number(process.env.PAYROLL_WORKER_MAX_STALLED_COUNT ?? 1),
} as const;
```

Applied via the decorator's second argument (verified with @nestjs/bullmq docs, `@Processor(queueName, workerOptions: NestWorkerOptions)`):
```ts
@Processor(PAYROLL_EVENTS_QUEUE, WORKER_OPTIONS)
export class PayrollEventProcessor extends WorkerHost { ... }
```
`lockDuration` (30 s) comfortably exceeds the max processing-tx duration (10 s timeout); `stalledInterval`/`maxStalledCount` (30 s / 1) re-queue a job whose worker died. Combined with D1's rollback, a re-queued job claims a `queued` row and proceeds.
**Why decorator-arg instead of `registerQueue`:** `@Processor` `workerOptions` is the framework's supported path (the `BullRegistrar` consumes `WORKER_METADATA`); env is the only source able to drive it without a global factory.

### D4 — `worker_heartbeats` + `/health` worker liveness (R4 observability, architecture D4)

```prisma
model WorkerHeartbeat {
  workerId   String   @id @map("worker_id")   // `${hostname}:${pid}` or env WORKER_ID
  hostname   String
  startedAt  DateTime @map("started_at")
  lastSeenAt DateTime @map("last_seen_at")
  @@map("worker_heartbeats")
}
```

- `src/processing/heartbeat.service.ts` (registered in `WorkerModule`): on `OnModuleInit` starts an unref'd `setInterval` at `WORKER_HEARTBEAT_INTERVAL_MS` (default 5 000) upserting the row; `touch()` (called at the top of each `process()`) bumps `lastSeenAt`; `OnModuleDestroy` clears the timer.
- `src/common/health/*` extends the response with `workers: [{ workerId, hostname, lastSeenAt, stale }]` and `stalled: number` (`queue.getJobCounts().stalled`); `status` is `degraded` when **any** worker is stale (`now − lastSeenAt > HEALTH_WORKER_STALE_MS`, default 15 000) **or** `stalled > 0`. `HealthResponseDto` gains these fields with Swagger descriptions/examples (touches `api-documentation`).
- API-side: the health controller resolves `WorkerHeartbeat[]` via the global `PrismaService`; the stalled count via the already-injected `Queue`.
**Why a table over Redis presence keys:** the DB is the source of truth (same philosophy as idempotency); operators see liveness history and it is queryable alongside events. Redis health is already covered by the existing `redis: ok|error`.

### D5 — Configuration surface

`PAYROLL_WORKER_LOCK_DURATION_MS` (30000), `PAYROLL_WORKER_STALLED_INTERVAL_MS` (30000), `PAYROLL_WORKER_MAX_STALLED_COUNT` (1) → worker Joi schema (`apps/worker/src/worker.module.ts`) **and** `.env.*` + compose `environment` blocks. `WORKER_HEARTBEAT_INTERVAL_MS` (5000) → worker Joi. `HEALTH_WORKER_STALE_MS` (15000) → API Joi (`src/app.module.ts`). All optional with defaults (no required-var startup failure; mirrors the idempotency-layer config pattern).

## Risks / Trade-offs

- **[Risk] Row lock held inside the tx — a hung worker blocks the row for the tx lifetime.** → Mitigation: the tx is short (`{ timeout: 10_000 }`, handler is an in-process simulation, ms-scale); `lockDuration` (30 s) > tx timeout; a hung connection is reaped by BullMQ stall detection and the row's claim rolls back on connection loss.
- **[Risk] Stuck-job re-claim requires BullMQ to actually re-queue the stalled job.** → Mitigation: explicit `stalledInterval`/`maxStalledCount` (D3) make it deterministic; `maxStalledCount = 1` re-queues on first stall.
- **[Risk] Transient rollback removes the row's `processing` marker — a NEW duplicate job could claim it mid-retry.** → Mitigation: there can be at most one queue job per employee (`jobId` FIFO), serializing claims; the row lock + guarded claim make a second claim a no-op even across workers.
- **[Risk] `/health` `degraded` on worker absence annoys compose healthchecks** (frontend/API compose healthcheck only pins the API `/health`, not worker freshness). → Mitigation: `degraded` reports, does not fail; compose healthchecks continue to pass as long as the API process and DB/Redis are up (verified: compose checks `ok`-level fields only at the top — the scenario keeps the API health while surfacing worker staleness).
- **[Trade-off] `event_attempts` skips transient attempts** — retry evidence lives in logs, not the table. Accepted because the table must be atomic with terminal commits (Non-Goals).

## Migration Plan

1. `prisma/schema.prisma`: add `EventAttempt`, `WorkerHeartbeat`, `AttemptStatus`, `AttemptErrorType`; generate migration (`npx prisma migrate dev --name worker_recovery_and_attempts`); **additive** — no existing column changes, rollback = redeploy previous image with tables unused.
2. Worker config + `WORKER_OPTIONS` + `@Processor` args (functionally reverts to current behavior if env unset, since defaults match today's implicit Wallet defaults).
3. `event-claim.ts` refactor of `process()` (behavioral; covered by unit + e2e), then heartbeat service, then `/health`.
4. e2e + docs (`docs/architecture.md` D4/D5 status; swagger HealthResponseDto).

## Open Questions

- Whether CI should assert a `degraded` `/health` during a deliberately-stopped worker (e2e), or whether the unit + shape assertions suffice.
- Exact `HealthResponseDto` field names (`workers`, `stalled`) — settled in the spec phase if reviewers prefer alternative names.