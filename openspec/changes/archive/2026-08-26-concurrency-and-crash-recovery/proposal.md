# Proposal: concurrency-and-crash-recovery

## Why

The worker's claim (`queued → processing`) commits **before** the handler runs and the terminal write happens in a **separate** statement. If the process crashes, is killed, or loses its connection anywhere in that window, the row is left in `processing` forever: BullMQ's stalled-job detection re-queues the job, but the claim guard sees a non-`queued` row and skips it — a permanent stuck event until manual intervention. The [`bullmq-queue-integration`](../archive/2026-08-25-bullmq-queue-integration/design.md) design explicitly deferred this ("row stuck in processing → re-claimed job skips it") to this change. There is also no DB-level row lock (`SELECT … FOR UPDATE SKIP LOCKED`), no explicit BullMQ stalled-job configuration, and no worker liveness signal in `/health` — so a dead worker is invisible to operators.

This change closes the roadmap's reliability gap #7: **concurrency safety (R3)**, **worker crash recovery (R4)**, and **transactional exactly-once processing (R5)**, matching the architecture document's D4/D5 design decisions.

## What Changes

- **Transactional processing transaction (`R5` exactly-once)** — the entire lifecycle (row lock → guarded claim → payload read → handler dispatch → terminal write) moves into one interactive Prisma transaction with `SELECT … FOR UPDATE` on the event row. Success commits `[processing → success + result + processed_at]` atomically; a crash or transient failure **rolls the claim back to `queued`** (nothing stuck). A transient failure aborts the transaction instead of an explicit `processing → queued` reset.
- **Per-event row lock (`R3` concurrency)** — the claim acquires `SELECT … FOR UPDATE` inside the transaction, so even across multiple worker instances sharing the queue, a re-claimed job blocks on the row and its guarded claim then matches 0 rows (skip), never double-processing; the jobId-per-employee FIFO remains the queue-level serialization.
- **Attempt audit trail (`event_attempts`)** — a new append-only table records every attempt that commits a terminal outcome (`attempt_number`, `status`, `error_type`, `failed_reason`, `result`): success, permanent failure, or retry exhaustion. Each row is written **in the same transaction** as the terminal `payroll_events` transition (transient retries remain observable via the existing structured `retrying` log lines — a row inside the aborted retry transaction would roll back anyway). This completes the audit-trail design promised in the architecture document.
- **BullMQ stalled-job recovery config (`R4`)** — explicit, env-configurable `lockDuration`, `stalledInterval`, and `maxStalledCount` on the worker so a dead worker's job is re-queued on a known schedule; combined with the transactional claim, a re-queued job now finds the row back in `queued` and reprocesses it.
- **Worker liveness in `/health` (`R4` observability)** — a `worker_heartbeats` table (upserted every 5 s per worker) and a `/health` deep check that reports per-worker `lastSeenAt` staleness and the BullMQ `stalled` job count; any stale worker or stalled job ⇒ `degraded`. The `HealthResponseDto` gains `workers` and `stalled` fields (additive contract change).
- **Config additions** — `PAYROLL_WORKER_LOCK_DURATION_MS`, `PAYROLL_WORKER_STALLED_INTERVAL_MS`, `PAYROLL_WORKER_MAX_STALLED_COUNT`, `WORKER_HEARTBEAT_INTERVAL_MS`, `HEALTH_WORKER_STALE_MS` across the Joi schemas, env files, and compose environment blocks.

**BREAKING** (internal, no public API removal): the `processing` lifecycle contract changes from "claim commits before work, then a separate terminal write" to "claim and terminal write commit together in one transaction". Consumers of the internal worker/service behavior (tests, the worker app) must align; no external REST contract is removed. The `/health` JSON body gains fields.

## Capabilities

### New Capabilities
<!-- None — the change hardens existing capabilities rather than introducing a new surface. -->

### Modified Capabilities
- `event-processing`: transactional exactly-once processing (row-locked claim + terminal write in one transaction, rollback-to-`queued` on crash/transient failure), and a new attempt-audit requirement (`event_attempts` table written atomically with the terminal transition).
- `event-queue`: worker-level recovery configuration — explicit stalled-job detection settings (`lockDuration`, `stalledInterval`, `maxStalledCount`) so a dead worker's job is re-queued and reprocessed.
- `health-check`: worker liveness — `worker_heartbeats` staleness and BullMQ `stalled` count in `/health`, with `degraded` semantics when any worker is stale or stalled.
- `api-documentation`: `HealthResponseDto` gains `workers` and `stalled` fields, documented with descriptions/examples.

## Impact

- **Code**: `apps/worker/src/payroll-event.processor.ts` (lifecycle → transactional), new `src/processing/event-claim.ts` (row-locked claim/process repository, per D5), new `src/processing/` heartbeat + attempt services, `src/common/health/health.controller.ts` + `HealthResponseDto` (liveness), `src/queue/` worker options wiring, config Joi schemas (`src/app.module.ts`, `apps/worker/src/worker.module.ts`).
- **Schema/migration**: new `event_attempts` and `worker_heartbeats` tables (additive; no changes to existing columns).
- **Env/docker**: 5 new env vars in `.env.example`, `.env.{development,test,production}`, `docker-compose.yml` / override `environment` blocks.
- **Tests**: unit specs for the transactional claim (rollback on transient, atomic commit on success), heartbeat upsert + staleness, health liveness; e2e for attempt trail + stalled/requeue recovery + `/health` degraded.
- **Docs**: `docs/architecture.md` D4/D5 now implemented; update the proposal's archived-proposal references.