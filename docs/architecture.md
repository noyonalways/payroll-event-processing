# Payroll Event Processing — Architecture & Reliability

> **Status:** Implemented — all roadmap changes 2–11 are shipped and the CI pipeline
> (backend lint/unit/build, frontend lint/vitest/build, full e2e against real
> Postgres + Redis service containers) is green on `main`.
>
> - Change 7 (`concurrency-and-crash-recovery`) ✅ — transactional row-locked
>   processing, `event_attempts`/`worker_heartbeats` tables, BullMQ stalled-job
>   recovery settings, worker liveness in `/health`.
> - Change 8 (`event-status-api`) ✅ — read-only `GET /events/:id` status + terminal
>   attempt trail (404 `ErrorResponseDto` on an unknown id).
> - Change 9 (`minimal-frontend`) ✅ — React/Vite demo UI with the `EMP-DEMO-*`
>   scenario lever (see `src/processing/demo-scenarios.ts`).
> - Change 10 (`test-suite`) ✅ — 111 backend unit tests, 40 e2e, 52 frontend.
> - Change 11 (`ci-and-docs`) ✅ — `.github/workflows/ci.yml`, README, this document.
>
> **Scope:** Full-system architecture + visual flows (roadmap changes 2–11).
> **Related:** The diagrams that illustrate this document (ERD, event flow, lifecycle
> state machine, system architecture) are on **Eraser**:
> <https://app.eraser.io/workspace/hIaUa8ZhdcDwT5YtdUiI>.

---

## 1. Context & goals

The service receives employee payroll events — `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`, `DEPARTMENT_CHANGE` — and processes them **asynchronously** so the HTTP response is fast and never blocked by (slow, occasionally failing) downstream work.

**Ground rules (from the assignment):**

- **Event submission** → validate → persist → enqueue → fast `201` response.
- **Worker** picks events off a queue, runs a *simulated* external payroll operation that **occasionally fails**, records the outcome.
- No authentication (out of scope). Reliability and test quality are the primary evaluation focus.

**Goals of this proposal:**

1. Give a single, reviewable picture of the whole system before code is written.
2. Make each of the 7 reliability requirements explicit: **where** it is enforced, and **how** it is enforced.
3. Provide visual flows (architecture, lifecycle, sequence) that match the planned implementation 1:1.

## 2. Non-goals

- No authentication/authorization, no multi-tenant isolation, no rate limiting by user.
- No real payroll provider integration — the provider is simulated.
- No event bus fan-out to multiple consumers (single consumer group) — ordering guarantees are per-employee, not global.
- No Kubernetes / secrets management / TLS in this iteration.
- No at-least-once *delivery* to end customers — the demo frontend polls the status API.

## 3. System architecture (high level)

See the **System Architecture** diagram in eraser.io. In prose:

```
                    ┌────────────────────────────────────────────┐
   Browser ────────►│  NestJS API :3000                          │
   (React/Vite)     │  EventsController (POST /events,         │
                    │    GET /events/:id — read-only status)     │
                    │  EventsService: validate → dedupe →        │
                    │    persist → enqueue → status read         │
                    └───────┬─────────────────▲──────────────────┘
                            │ Prisma          │ 201 { id, status }
                 ┌──────────▼──────────┐   ┌──┴──────────────┐
                 │ PostgreSQL 16       │   │ Redis 7         │
                 │ payroll_events      │   │ BullMQ          │
                 │ event_attempts      │   │ (jobs/retries)  │
                 │ idempotency_records │   │                 │
                 │ worker_heartbeats   │   │                 │
                 └──────────▲──────────┘   └──▲──────────────┘
                            │ claimed + written
                 ┌──────────┴──────────────────┴──────────────┐
                 │  BullMQ Worker (apps/worker)                │
                 │  per-employee FIFO consumer                 │
                 │  handler strategy registry                  │
                 │  retry/backoff strategy                     │
                 │  transactional exactly-once commit          │
                 └──────────────┬──────────────────────────────┘
                                │ HTTP (simulated)
                 ┌──────────────▼──────────────┐
                 │ Simulated Payroll Provider  │
                 │ transient/permanent failures│
                 └─────────────────────────────┘
```

**Key components & responsibilities:**

| Component | Responsibility | Reliability role |
|---|---|---|
| **NestJS API** | DTO validation (class-validator class-transformer), per-type validation rules, shared idempotency layer (`IdempotencyService` store-and-replay), persist + enqueue | Idempotency, fast response |
| **Redis / BullMQ** | Job queue keyed per employee (`jobId = employeeId` → FIFO), delayed jobs for backoff, stalled-job detection | Ordering, retries, crash recovery |
| **Worker** | Claim job, side-effect marker (`processing`), row lock, handler dispatch, provider call, transactional commit | Exactly-once, concurrency, recovery |
| **PostgreSQL / Prisma** | `payroll_events` + `event_attempts` + `worker_heartbeats`, unique constraints, status transition guard, `SELECT … FOR UPDATE` (plain) row lock inside an interactive `$transaction` | Ground truth, atomicity, dedup |
| **Simulated provider** | Random temp/perm failure (`PAYROLL_TEMPORARY_FAILURE_RATE`, `PAYROLL_PERMANENT_FAILURE_RATE`) | Testability of failure paths |

## 4. Event lifecycle

State machine (see the **Event Lifecycle** diagram):

```
                 submit                    enqueue                 claim + lock (in ONE tx)
POST /events ─────►  received  ───────────►  queued  ───────────────►  processing
                         │                                              │   │
                         │                                              │   ├─ temp failure ── RE-THROW → tx ABORT ──► queued  (claim rolled back)
                    persist                                          success   │
                    (status=received)                                  │   └─ permanent failure / max attempts ──► failed (dead-letter)
                                                                       ▼
                                                                    success
                        (transactional commit, attempt row + result written together)
```

**Transitions:**

| From → To | Trigger | Guard |
|---|---|---|
| `received` → `queued` | job enqueued after successful persist | transaction committed |
| `queued` → `processing` | worker claims job (inside the interactive tx, after `SELECT … FOR UPDATE`) | `UPDATE … WHERE status='queued'` must match 1 row; count 0 → skip |
| `processing` → `success` | provider call succeeded | transaction commits `processing→success` + result/processed_at + SUCCESS attempt row together |
| `processing` → `queued` | transient failure (retry) | **tx ABORT — no explicit reset write**: the re-throw rolls the claim back |
| `processing` → `failed` | permanent failure | transaction commits `processing→failed` + FAILED(PERMANENT) attempt row together |
| `queued` → `failed` | retries exhausted (transient) | `onFailed` array transaction commits `queued→failed` + upserts the final attempt's FAILED(TEMPORARY) row (already appended by the last transient failure) |
| `failed` → (dead) | dead-letter | terminal, never reprocessed |

## 5. Reliability design (the core of the assignment)

Each requirement mapped to its enforcement point.

### R1 — Temporary vs permanent failure
- **Temporary** (provider down, timeout, 5xx): retried with exponential backoff; attempt `error_type=TEMPORARY`.
- **Permanent** (business/validation error surfaced by provider): event → `failed`, `failedReason` recorded, **never retried** (dead-letter).
- Simulated via env-tunable probabilities so both paths are testable (`PAYROLL_TEMPORARY_FAILURE_RATE=0.25`, `PAYROLL_PERMANENT_FAILURE_RATE=0.05`).
- **Enforced in:** BullMQ `attempts`/`backoff` config (set by the producer, `payroll-event-queue.service.ts`) + the worker's transient-error **re-throw** (`payroll-event.processor.ts`); `event_attempts.error_type`.

### R2 — Idempotency (no duplicate business effects)
- Client sends a required `Idempotency-Key` header.
- A shared NestJS idempotency layer (`src/common/idempotency`, `idempotency_records` table) dedupes under `(scope, key)`; the **`UNIQUE (scope, key)`** constraint on the table is the DB's final arbiter.
- On a miss, the submit operation and the record insert (`responseStatus`/`responseBody`/`expiresAt`) commit in the **same transaction**; duplicate submits replay the stored response with no new side effects. A rare race on the unique index is caught as a `P2002` constraint violation and treated as the same duplicate path (post-transaction winner read).
- Records are TTL'd (`IDEMPOTENCY_TTL_SECONDS`, default 86400 s) and swept (`IDEMPOTENCY_SWEEP_INTERVAL_MS`, default 60 s); an expired key is treated as absent — the expired row is deleted inside the transaction before the new insert.
- `payroll_events.idempotency_key` stays `NOT NULL` (non-unique) purely for traceability.
- **Enforced in:** `IdempotencyService.execute(scope, key, op)` + `UNIQUE (scope, key)` on `idempotency_records`.

### R3 — Concurrency safety (multiple workers)
- Per-employee FIFO: BullMQ `jobId = employeeId` keeps jobs for one employee ordered, while different employees process in parallel.
- On top of the queue, the worker takes `SELECT … FOR UPDATE` on the event row inside the processing transaction (`event-claim.ts`), so two workers can never process the same event concurrently — the loser blocks on the lock, then its guarded claim (`WHERE status='queued'`) matches 0 rows and it applies no side effects (skip).
- **Enforced in:** queue job naming + DB row lock + guarded claim (`concurrency-and-crash-recovery`).

### R4 — Worker crash recovery
- The claim (`queued → processing`) + terminal write now run in **ONE transaction**: a crash or dropped connection at any point before commit ABORTS the transaction, so the row rolls back to `queued` — it can never be left stuck in `processing` (the old non-transactional claim could).
- BullMQ **stalled-job recovery** (`WORKER_OPTIONS`: `lockDuration` 30 s > the 10 s processing-tx timeout, `stalledInterval` 30 s, `maxStalledCount` 1) re-queues a job whose worker died mid-work.
- Workers publish a **liveness heartbeat** (`worker_heartbeats`, upserted `WORKER_HEARTBEAT_INTERVAL_MS`/5 s) and `/health` degrades when any heartbeat is stale (`HEALTH_WORKER_STALE_MS`/15 s) or `stalled > 0`.
- **Enforced in:** worker + BullMQ config (env-tunable `PAYROLL_WORKER_*`), `HeartbeatService`, `/health` (`workers[]`/`stalled`).

### R5 — Exactly-once / processing consistency
- The terminal write is **transactional**: `event → success/failed` + the `event_attempts` row commit in the SAME transaction as the guarded claim — the row lock means exactly one worker holds the claim, so the handler result applied exactly once.
- The update is guarded: `UPDATE payroll_events SET status='success' WHERE id=? AND status='processing'` — a crash-then-reprocess can only succeed once; the second attempt matches 0 rows and is skipped.
- Retry exhaustion writes `queued → failed` + the final FAILED(TEMPORARY) attempt row (upserted — the last transient failure already appended it) in one array `$transaction`.
- **Enforced in:** transactional `event-claim.ts` + status guard + `onFailed` exhaustion transaction.

### R6 — Event ordering per employee
- Monotonic `sequence` per employee (computed on insert), used for inspection/audit and tests.
- FIFO queue group by `employeeId` (`jobId = employeeId`) → ordering guaranteed within an employee, parallelism across employees.
- **Enforced in:** API persist (sequence) + queue producer (`jobId`).

### R7 — Extensibility
- Handler strategy registry: `Map<EventType, PayrollHandler>`; a new event type = new DTO + new handler registered, no controller/service change.
- DTOs are per-type with their own required fields (see README table).
- **Enforced in:** `src/processing/handlers` registry.

## 6. Data model

See the **ERD** in eraser.io. Four tables:

**`payroll_events`** — one row per submitted event.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `event_type` | enum/text | `BANK_ACCOUNT_CHANGE` \| `ADDRESS_CHANGE` \| `SALARY_CHANGE` \| `DEPARTMENT_CHANGE` |
| `employee_id` | text | group key for ordering |
| `payload` | JSONB | validated event payload |
| `sequence` | bigint | per-employee monotonic counter |
| `idempotency_key` | text | **NOT NULL** — traceability only, non-unique index |
| `status` | enum | `received` \| `queued` \| `processing` \| `success` \| `failed` |
| `created_at` / `updated_at` | timestamptz | |
| `processed_at` | timestamptz nullable | set on success |

**Constraints/indexes:** `UNIQUE(employee_id, sequence)`, index on `status`, index on `(employee_id, created_at)`, index on `idempotency_key`. The dedup response lives in `idempotency_records`, not on this row.

**`idempotency_records`** — store-and-replay dedup state for the shared idempotency layer, keyed by `(scope, key)`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `scope` | text | idempotency partition (e.g. `event-submission`) |
| `key` | text | client `Idempotency-Key` value |
| `response_status` | int | stored HTTP status returned to duplicates |
| `response_body` | jsonb | stored `201` body returned to duplicates |
| `expires_at` | timestamptz | TTL; swept and reused after expiry |
| `created_at` | timestamptz | |

**Constraints/indexes:** `UNIQUE (scope, key)` — the dedup arbiter; index on `expires_at` for the sweep (`deleteMany(expires_at < now)`).

**`event_attempts`** — append-only audit trail of every attempt that ran, at most one row per `(event_id, attempt_number)` (`UNIQUE`). A transient failure appends its `FAILED(TEMPORARY)` row right after the claim transaction aborts; the terminal `SUCCESS` / `FAILED(PERMANENT)` row commits in the same transaction as the terminal `payroll_events` write (`AttemptStatus`/`AttemptErrorType` enums).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `event_id` | UUID FK → `payroll_events` | indexed (`@@index([eventId])`) |
| `attempt_number` | int | 1-based; which attempt this row records · `UNIQUE (event_id, attempt_number)` — one row per attempt |
| `status` | enum | `SUCCESS` \| `FAILED` |
| `error_type` | enum nullable | `TEMPORARY` \| `PERMANENT` |
| `failed_reason` | text nullable | why it failed |
| `result` | JSONB nullable | provider result on success (== the event row's `result`) |
| `created_at` | timestamptz | when the attempt row was appended (a transient row right after the claim aborted; the terminal row at the terminal commit) |

**`worker_heartbeats`** — worker liveness for `/health` (D4).

| Column | Type | Notes |
|---|---|---|
| `worker_id` | text PK | stable worker id |
| `hostname` | text | |
| `started_at` | timestamptz | worker start time |
| `last_seen_at` | timestamptz | upserted every 5 s |

**Note:** `idempotency_key` is `NOT NULL` + non-unique index (D1), and dedup state lives in `idempotency_records` — the ERD in eraser.io is updated to match.

## 7. Sequence flows

Both flows are visualized in a single end-to-end sequence diagram in eraser.io.

### 7.1 Event submission (idempotent, non-blocking)

1. `Client → POST /events` with `Idempotency-Key` + typed payload.
2. API validates DTO → `400` on invalid; missing/blank key → `400` (`@IdempotencyKey()`).
3. `IdempotencyService.execute('event-submission', key, op)` — fast-path `findUnique`; **record found & unexpired → return stored response** (no new side effects).
4. On miss, one transaction: delete any still-expired `(scope, key)` row, take the per-employee advisory lock, compute next `sequence`, insert `payroll_events(status=received)` **and** the `idempotency_records` row together (a `P2002` race on the unique key → post-transaction winner read → duplicate path → stored response).
5. Enqueue BullMQ job (`jobId = employeeId`), mark `queued`.
6. Return `201 { id, status: 'received' }`. HTTP returns within milliseconds; provider work happens later.

### 7.2 Worker processing (exactly-once, retry, recovery)

1. Worker fires for a claimed job; `received → queued` ensure (relay make-safe) runs **outside** the claim transaction, then `HeartbeatService.touch()` bumps the worker liveness row.
2. **ONE interactive transaction** (`event-claim.ts`, `{ timeout: 10_000, maxWait: 5_000 }`):
   a. **Concurrency lock:** `SELECT id FROM payroll_events WHERE id=? FOR UPDATE` (`$queryRaw` — Prisma has no FOR UPDATE builder).
   b. **Guarded claim:** `UPDATE payroll_events SET status='processing' WHERE id=? AND status='queued'` — 0 rows → stale/duplicate, skip with no side effects.
   c. **Payload read** inside the tx (the DB row stays the source of truth), then dispatch through the handler registry.
3. **Success** → commit `[event → success + result/processed_at + attempt → SUCCESS w/ result]` → ack job.
4. **Transient failure** → re-throw inside the tx → **ABORT** → the claim rolls back to `queued` (no explicit reset) and the attempt's `FAILED(TEMPORARY)` audit row is appended outside the aborted transaction → BullMQ schedules the retry with exponential backoff.
5. **Permanent failure** → commit `[event → failed + attempt → FAILED(PERMANENT, reason)]`, no retry (dead-letter).
6. **Retries exhausted** (transient) → `onFailed` array `$transaction` commits `[queued → failed]` + upserts the final attempt's `FAILED(TEMPORARY)`, reason row — idempotent with the row the last transient failure already appended.
7. **Crash anywhere** between lock and commit → the transaction aborts → the row is back in `queued` (never stuck in `processing`); BullMQ stalled-job detection additionally re-queues a job whose worker died mid-work, and a fresh worker reprocesses safely thanks to the guarded claim + terminal status guard.

### 7.3 Read-only status (`GET /events/:id`, event-status-api)

The status endpoint is a READ-ONLY pair of sequential reads — no `Idempotency-Key`,
no mutation.

1. Client → `GET /events/:id`. Unknown id → `NotFoundException`, shaped by the global
   `HttpExceptionFilter` into the documented 404 `ErrorResponseDto`.
2. `event_attempts` trail fetched `WHERE eventId = :id ORDER BY attemptNumber ASC`
   and re-sorted at the boundary — the response's `attempts[]` is always ascending
   regardless of store order.
3. Response `200 EventStatusResponseDto`: committed `status` (lowercase wire format:
   `received`|`queued`|`processing`|`success`|`failed`), event details, `sequence`
   coerced `BigInt → Number` (never a raw BigInt on the wire), `processedAt`/`result`
   on `success`, null otherwise, and one `EventAttemptDto` per attempt with
   `attemptNumber`/`status`/`errorType`/`failedReason`/`result`/`createdAt`.

The reported `status` always mirrors the committed `payroll_events` row: because the
claim is rolled back on any abort, polling between BullMQ retry attempts observes
`queued` with the attempts that have already run on the trail — never a stuck
`processing`.

## 8. Failure modes & recovery

| Failure | Observable effect | Recovery |
|---|---|---|
| Provider down (all attempts) | row returns to `queued` between retries, ends `failed` | tx abort on transient; exhausted → `failed` w/ reason, dead-letter |
| Business/validation error from provider | attempt `error_type=PERMANENT` | event `failed` (tx), never retried |
| Worker crashes mid-processing | transaction never commits | tx abort rolls the row back to `queued`; stalled-job detection re-queues → reprocess (guarded) |
| Duplicate client submit (same key) | second `POST` | idempotency short-circuit returns stored `201` |
| Duplicate submit race (concurrent) | unique constraint violation | caught → treated as duplicate |
| Two workers same event | both claim same job row | `FOR UPDATE` row lock + guarded claim → only one proceeds |
| Invalid payload | — | `400` at submission, nothing persisted |
| Demo scenario id (`EMP-DEMO-*`, see `src/processing/demo-scenarios.ts`) | forced outcome per submission: success, `failed`/`PERMANENT` (attempt 1), transient retries → `failed`/`TEMPORARY` (every attempt), transient-then-success (attempt 3), or transient-then-permanent (attempt 3, `FAILAFTER`) | deterministic override, wins over `PAYROLL_FAILURE_MODE`; reviewer lever for the demo UI — each attempt is recorded on the audit trail |

## 9. Mapping to the roadmap

| Roadmap change | Delivers |
|---|---|
| 1 `project-scaffold` ✅ | runnable baseline (done) |
| 2 `event-submission-api` ✅ | DTOs/validation, `payroll_events` schema, POST /events |
| 3 `bullmq-queue-integration` ✅ | producer + worker, per-employee FIFO |
| 4 `simulated-payroll-processor` ✅ | handler registry, simulated provider, `EMP-DEMO-*` scenarios |
| 5 `retry-and-failure-strategy` ✅ | temp vs perm, backoff, dead-letter |
| 6 `idempotency-layer` ✅ | required Idempotency-Key, dedupe |
| 7 `concurrency-and-crash-recovery` ✅ | row lock + transactional claim/terminal commit, event_attempts audit, stalled-job recovery config, worker heartbeats + /health liveness |
| 8 `event-status-api` ✅ | GET /events/:id — read-only status + attempt trail (remaining roadmap: GET /events list, GET /events/:id/history) |
| 9 `minimal-frontend` ✅ | demo UI (submit / live status / detail) with scenario selector |
| 10 `test-suite` ✅ | unit + e2e incl. recovery + frontend Vitest (111 / 40 / 52 tests) |
| 11 `ci-and-docs` ✅ | `.github/workflows/ci.yml` (backend + frontend + e2e jobs), README + this doc — Swagger/OpenAPI delivered early by `swagger-openapi` (UI /api-docs, JSON /api-docs-json) |

## 10. Decisions (closed — implementation-ready)

All previously open items are now settled with concrete values.

### D1 — `idempotency_key`: `NOT NULL` + non-unique index (confirmed, revised in `idempotency-layer`)
Required `Idempotency-Key` header; dedup is enforced by `UNIQUE (scope, key)` on the dedicated `idempotency_records` table; `payroll_events.idempotency_key` stays `NOT NULL` (indexed) purely for traceability. A nullable key cannot guarantee dedup.

### D2 — Stored response on dedupe: dedicated `idempotency_records` table, TTL'd + swept (no Redis cache)
The shared idempotency layer keeps one row per `(scope, key)` holding `response_status` + `response_body`, written in the **same insert transaction** as the business row. Duplicate/key-reuse submits read that row and return exactly the stored response; records expire (`IDEMPOTENCY_TTL_SECONDS`) and are swept (`IDEMPOTENCY_SWEEP_INTERVAL_MS`), and an expired key becomes reusable.
**Why:** the DB is already the dedup arbiter via `UNIQUE (scope, key)`, so correctness never depends on a TTL'd cache; a Redis cache would only add eviction + coherence failure modes. The separate table keeps the dedup state independent of the business row and is generic across scopes. This supercedes the earlier design that stored the response on the `payroll_events` row (columns removed in the `idempotency_records` migration).

### D3 — Retry bounds: `maxAttempts = 5`, exponential backoff 1 s base, all env-config
BullMQ: `attempts: PAYROLL_MAX_RETRY_ATTEMPTS` (default 5 = 1 initial + 4 retries), `backoff: { type: 'exponential', delay: PAYROLL_RETRY_BASE_DELAY_MS }` — BullMQ computes each delay as `base × 2^(attempt−1)` → 1/2/4/8 s (no jitter: the plain schedule keeps delays deterministic, which the retry-exhaustion e2e relies on).
Env vars: `PAYROLL_MAX_RETRY_ATTEMPTS` (5), `PAYROLL_RETRY_BASE_DELAY_MS` (1000).
Permanent errors are thrown **non-retryable**, so the job fails immediately and the DB is the dead-letter (`status='failed'` + `error_type='PERMANENT'` + `failedReason`). `removeOnComplete`/`removeOnFail: true` keep Redis bounded — the audit trail lives in Postgres, not Redis — and freeing a completed job's `jobId` is also what lets the relay re-use the per-employee key (`payroll-event-queue.service.ts`).

### D4 — Worker liveness: heartbeat table + `/health` deep check (✅ implemented)
New `worker_heartbeats` table (`worker_id` PK, `hostname`, `started_at`, `last_seen_at`) upserted by `HeartbeatService` (`WORKER_HEARTBEAT_INTERVAL_MS`, default 5000, unref'd timer + immediate touch; `workerId` = `WORKER_ID` env or `${hostname}:${pid}`). `/health` (`HealthResponseDto`) now returns `workers: WorkerLivenessDto[]` (`workerId`/`hostname`/`lastSeenAt`/`stale`) plus `stalled: number` (`queue.getJobCounts()`); any worker `lastSeenAt` older than `HEALTH_WORKER_STALE_MS` (default 15000) or `stalled > 0` ⇒ `degraded`.
BullMQ recovery is env-tunable via `WORKER_OPTIONS` (computed at module import — config freezes at import): `lockDuration` (default 30_000, must exceed the 10 s processing-tx timeout so a healthy worker never false-stalls), `stalledInterval` (30_000), `maxStalledCount` (1) — a crashed worker's job is re-queued within ~30 s and our status guard makes reprocessing safe.

### D5 — Row lock: interactive Prisma transaction with `$queryRaw` (✅ implemented)
```ts
await prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM payroll_events WHERE id = ${eventId} FOR UPDATE`;
  const claimed = await tx.payrollEvent.updateMany({
    where: { id: eventId, status: 'queued' },
    data: { status: 'processing' },
  });
  if (claimed.count === 0) return { outcome: 'skipped' };
  // payload read → handler dispatch → terminal update + event_attempts row,
  // OR re-throw TransientPayrollFailureError to ABORT (claim rolls back).
}, { timeout: 10_000, maxWait: 5_000 });
```
**Why:** Prisma's query builder has no FOR UPDATE support (verified); the supported way is `$queryRaw` inside an interactive `$transaction`, which also exposes the guarded `UPDATE`. Plain `FOR UPDATE` (not `SKIP LOCKED`) is correct here because the second contender blocks, then its guarded claim matches 0 rows and it skips — every job still gets one definitive verdict. Isolated in `src/processing/event-claim.ts`; the transaction stays short (well under `lockDuration`), and a transient failure re-throw aborts it with **no explicit `processing → queued` reset** — the rollback IS the reset, so a crash at any point also leaves the row claimable (R4).