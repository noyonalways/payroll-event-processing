# Payroll Event Processing — Architecture & Reliability Proposal

> **Status:** Proposal for review — created before feature implementation begins.
> **Scope:** Full-system architecture + visual flows for the as-yet-unbuilt feature changes (roadmap changes 2–11).
> **Related:** eraser.io Draft file contains the diagrams that illustrate this document.

---

## 1. Context & goals

The service receives employee payroll events — `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE` — and processes them **asynchronously** so the HTTP response is fast and never blocked by (slow, occasionally failing) downstream work.

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
                    │    GET /events, GET /events/:id/history)   │
                    │  EventsService: validate → dedupe →        │
                    │    persist → enqueue                       │
                    └───────┬─────────────────▲──────────────────┘
                            │ Prisma          │ 201 { id, status }
                 ┌──────────▼──────────┐   ┌──┴──────────────┐
                 │ PostgreSQL 16       │   │ Redis 7         │
                 │ payroll_events      │   │ BullMQ          │
                 │ event_attempts      │   │ (jobs/retries)  │
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
| **NestJS API** | DTO validation (class-validator class-transformer), per-type validation rules, idempotency short-circuit, persist + enqueue | Idempotency, fast response |
| **Redis / BullMQ** | Job queue keyed per employee (`jobId = employeeId` → FIFO), delayed jobs for backoff, stalled-job detection | Ordering, retries, crash recovery |
| **Worker** | Claim job, side-effect marker (`processing`), row lock, handler dispatch, provider call, transactional commit | Exactly-once, concurrency, recovery |
| **PostgreSQL / Prisma** | `payroll_events` + `event_attempts`, unique constraints, status transition guard, `SELECT … FOR UPDATE SKIP LOCKED` | Ground truth, atomicity, dedup |
| **Simulated provider** | Random temp/perm failure (`PAYROLL_TEMPORARY_FAILURE_RATE`, `PAYROLL_PERMANENT_FAILURE_RATE`) | Testability of failure paths |

## 4. Event lifecycle

State machine (see the **Event Lifecycle** diagram):

```
                 submit                    enqueue                    claim + lock
POST /events ─────►  received  ───────────►  queued  ───────────────►  processing
                         │                                              │   │
                         │                                              │   ├─ temp failure ── retry (exp. backoff) ──► queued  (bounded)
                    persist                                          success   │
                    (status=received)                                  │   └─ permanent failure / max attempts ──► failed (dead-letter)
                                                                       ▼
                                                                    success
                                      (transactional commit, attempt+result recorded)
```

**Transitions:**

| From → To | Trigger | Guard |
|---|---|---|
| `received` → `queued` | job enqueued after successful persist | transaction committed |
| `queued` → `processing` | worker claims job | `UPDATE … WHERE status='queued'` must match 1 row |
| `processing` → `success` | provider call succeeded | transactional write, status guard `processing→success` |
| `processing` → `queued` | transient failure (retry) | attempts < max |
| `processing` → `failed` | permanent failure OR retries exhausted | business error or max attempts |
| `failed` → (dead) | dead-letter | terminal, never reprocessed |

## 5. Reliability design (the core of the assignment)

Each requirement mapped to its enforcement point.

### R1 — Temporary vs permanent failure
- **Temporary** (provider down, timeout, 5xx): retried with exponential backoff; attempt `error_type=TEMPORARY`.
- **Permanent** (business/validation error surfaced by provider): event → `failed`, `failedReason` recorded, **never retried** (dead-letter).
- Simulated via env-tunable probabilities so both paths are testable (`PAYROLL_TEMPORARY_FAILURE_RATE=0.25`, `PAYROLL_PERMANENT_FAILURE_RATE=0.05`).
- **Enforced in:** worker `RetryStrategy` + BullMQ `attempts`/`backoff` config; `event_attempts.error_type`.

### R2 — Idempotency (no duplicate business effects)
- Client sends a required `Idempotency-Key` header.
- `idempotency_key` is **`NOT NULL` + `UNIQUE`** on `payroll_events` — the DB is the final arbiter.
- On duplicate submit: API short-circuits and returns the stored `201` response; a rare race on the unique index is caught as a constraint violation and treated as the same duplicate path.
- **Enforced in:** API `IdempotencyGuard` + DB unique constraint.

### R3 — Concurrency safety (multiple workers)
- Per-employee FIFO: BullMQ `jobId = employeeId` keeps jobs for one employee ordered, while different employees process in parallel.
- On top of the queue, the worker takes `SELECT … FOR UPDATE SKIP LOCKED` on the event row inside the processing transaction, so two workers can never process the same event concurrently.
- **Enforced in:** queue job naming + DB row lock (`concurrency-and-crash-recovery` change).

### R4 — Worker crash recovery
- The event transitions to `processing` **before** any side-effect starts (side-effect marker), so a crash leaves a visible stuck state.
- BullMQ **stalled-job detection** (`stalledInterval`, `maxStalledCount`) re-queues a job whose worker died mid-work.
- Re-processing is safe because of the status transition guard (R5).
- **Enforced in:** worker + BullMQ config; make visible in `/health`.

### R5 — Exactly-once / processing consistency
- The success write is **transactional**: `event → success` + `event_attempts` row (result) commit together.
- The update is guarded: `UPDATE payroll_events SET status='success' WHERE id=? AND status='processing'` — a crash-then-reprocess can only succeed once; the second attempt matches 0 rows and is discarded.
- **Enforced in:** worker transactional commit + status guard.

### R6 — Event ordering per employee
- Monotonic `sequence` per employee (computed on insert), used for inspection/audit and tests.
- FIFO queue group by `employeeId` (`jobId = employeeId`) → ordering guaranteed within an employee, parallelism across employees.
- **Enforced in:** API persist (sequence) + queue producer (`jobId`).

### R7 — Extensibility
- Handler strategy registry: `Map<EventType, PayrollHandler>`; a new event type = new DTO + new handler registered, no controller/service change.
- DTOs are per-type with their own required fields (see README table).
- **Enforced in:** `src/processing/handlers` registry.

## 6. Data model

See the **ERD** in eraser.io. Three tables:

**`payroll_events`** — one row per submitted event.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `event_type` | enum/text | `BANK_ACCOUNT_CHANGE` \| `ADDRESS_CHANGE` \| `SALARY_CHANGE` |
| `employee_id` | text | group key for ordering |
| `payload` | JSONB | validated event payload |
| `sequence` | bigint | per-employee monotonic counter |
| `idempotency_key` | text | **NOT NULL, UNIQUE** (locked decision) |
| `status` | enum | `received` \| `queued` \| `processing` \| `success` \| `failed` |
| `created_at` / `updated_at` | timestamptz | |
| `processed_at` | timestamptz nullable | set on success |
| `response_status` | int | stored HTTP status returned to duplicates — D2 |
| `response_body` | jsonb | stored `201` body returned to duplicates — D2 |

**Constraints/indexes:** `UNIQUE(idempotency_key)`, `UNIQUE(employee_id, sequence)`, index on `status`, index on `(employee_id, created_at)`.

**`event_attempts`** — append-only audit trail (one row per processing attempt).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `event_id` | UUID FK → `payroll_events` | |
| `attempt_number` | int | 1-based |
| `status` | enum | `processing` \| `success` \| `failed` |
| `error_type` | enum nullable | `TEMPORARY` \| `PERMANENT` |
| `failed_reason` | text nullable | why it failed |
| `result` | JSONB nullable | provider result on success |
| `started_at` / `finished_at` | timestamptz nullable | |

**`worker_heartbeats`** — worker liveness for `/health` (D4).

| Column | Type | Notes |
|---|---|---|
| `worker_id` | text PK | stable worker id |
| `hostname` | text | |
| `started_at` | timestamptz | worker start time |
| `last_seen_at` | timestamptz | upserted every 5 s |

**Note:** `idempotency_key` is `NOT NULL` + `UNIQUE` (D1) — the ERD in eraser.io is updated to match.

## 7. Sequence flows

Both flows are visualized in a single end-to-end sequence diagram in eraser.io.

### 7.1 Event submission (idempotent, non-blocking)

1. `Client → POST /events` with `Idempotency-Key` + typed payload.
2. API validates DTO → `400` on invalid; missing key → `400`.
3. API looks up `idempotency_key`; **if found → return stored `201`** (no new side effects).
4. If new: transactional insert `payroll_events(status=received)` + compute `sequence` (unique violation on race → duplicate path → return stored `201`).
5. Enqueue BullMQ job (`jobId = employeeId`), mark `queued`.
6. Return `201 { id, status: 'queued' }`. HTTP returns within milliseconds; provider work happens later.

### 7.2 Worker processing (exactly-once, retry, recovery)

1. Worker fires for a claimed job.
2. **Side-effect marker:** `UPDATE payroll_events SET status='processing' WHERE id=? AND status='queued'` — 0 rows → stale/duplicate, skip.
3. **Concurrency lock:** `SELECT … FOR UPDATE SKIP LOCKED` on the row.
4. Append `event_attempts` (`attempt_number` next, status `processing`).
5. Resolve handler via registry by `event_type`.
6. Call simulated provider.
7. **Success** → commit `[event → success + attempt → success w/ result]` → ack job.
8. **Transient failure** → mark attempt `failed(TEMPORARY)`; if `attempts < max` re-enqueue with exponential backoff → `queued`; else → step 9.
9. **Permanent failure / exhausted retries** → `event → failed`, attempt `failed(PERMANENT, reason)`, dead-letter (no further processing).
10. **Crash anywhere** → event stuck in `processing`; BullMQ stalled-job detection re-queues; a fresh worker reprocesses safely thanks to the status guard (step 2) — a crash-then-reprocess can never double-apply.

## 8. Failure modes & recovery

| Failure | Observable effect | Recovery |
|---|---|---|
| Provider down (all attempts) | status stuck `processing`, job retrying | backoff → eventually `failed` w/ reason, dead-letter |
| Business/validation error from provider | attempt `error_type=PERMANENT` | event `failed`, never retried |
| Worker crashes mid-processing | event `processing`, job stalled | BullMQ stalled-job detection re-queues → reprocess (guarded) |
| Duplicate client submit (same key) | second `POST` | idempotency short-circuit returns stored `201` |
| Duplicate submit race (concurrent) | unique constraint violation | caught → treated as duplicate |
| Two workers same event | both claim same job row | `SKIP LOCKED` + status guard → only one proceeds |
| Invalid payload | — | `400` at submission, nothing persisted |

## 9. Mapping to the roadmap

| Roadmap change | Delivers |
|---|---|
| 1 `project-scaffold` ✅ | runnable baseline (done) |
| 2 `event-submission-api` | DTOs/validation, `payroll_events` schema, POST /events |
| 3 `bullmq-queue-integration` | producer + worker, per-employee FIFO |
| 4 `simulated-payroll-processor` | handler registry, simulated provider, attempt logging |
| 5 `retry-and-failure-strategy` | temp vs perm, backoff, dead-letter |
| 6 `idempotency-layer` | required Idempotency-Key, dedupe |
| 7 `concurrency-and-crash-recovery` | row locking, status guard, stalled jobs, exactly-once |
| 8 `event-status-api` | GET /events, GET /events/:id/history |
| 9 `minimal-frontend` | demo UI (submit / live status) |
| 10 `test-suite` | unit/integration/e2e incl. recovery test |
| 11 `ci-and-docs` | CI, final diagram — Swagger/OpenAPI delivered early by `swagger-openapi` (UI /api-docs, JSON /api-docs-json) |

## 10. Decisions (closed — implementation-ready)

All previously open items are now settled with concrete values.

### D1 — `idempotency_key`: `NOT NULL` + `UNIQUE` (confirmed)
Required `Idempotency-Key` header; `UNIQUE(idempotency_key)` on `payroll_events`. A nullable key cannot guarantee dedup. No further action.

### D2 — Stored response on dedupe: persist it on the DB row (no Redis cache)
Add `response_status` (int) + `response_body` (jsonb), `NOT NULL`, written in the **same insert transaction**. A duplicate submit reads the row and returns exactly the stored response.
**Why:** the DB is already the dedup arbiter via the unique key, so correctness never depends on a TTL'd cache; a Redis cache would only add eviction + coherence failure modes. An optional Redis warm-path cache can be added later purely for latency, with the DB as source of truth.

### D3 — Retry bounds: `maxAttempts = 5`, exponential backoff 1 s base + 50 % jitter, all env-config
BullMQ: `attempts: 5` (1 initial + 4 retries), `backoff: { type: 'exponential', delay: 1000, jitter: 0.5 }` → delays ≈ 1/2/4/8 s with ±50 % jitter.
Env vars: `PAYROLL_MAX_ATTEMPTS` (5), `PAYROLL_RETRY_BASE_DELAY_MS` (1000), `PAYROLL_RETRY_JITTER` (0.5).
Permanent errors are thrown **non-retryable**, so the job fails immediately and the DB is the dead-letter (`status='failed'` + `error_type='PERMANENT'` + `failedReason`). Set `removeOnComplete`/`removeOnFail` so Redis stays bounded — the audit trail lives in Postgres, not Redis.
(Verified: BullMQ 4.x supports `jitter` in exponential backoff.)

### D4 — Worker liveness: heartbeat table + `/health` deep check
New `worker_heartbeats` table (`worker_id` PK, `hostname`, `started_at`, `last_seen_at`) upserted every 5 s per worker. `/health` deep check returns per-worker `lastSeenAt` plus the BullMQ `stalled` job count (`queue.getJobCounts()['stalled']`); any worker stale > 15 s or `stalled > 0` ⇒ `degraded`.
Keep BullMQ defaults for recovery: `stalledInterval: 30_000`, `maxStalledCount: 1`, `lockDuration: 30_000` — a crashed worker's job is re-queued within ~30 s and our status guard makes reprocessing safe.

### D5 — Row lock: interactive Prisma transaction with `$queryRaw` (isolated)
```ts
await prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM "payroll_events" WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
  // …guarded UPDATE (status 'queued' → 'processing') + attempt insert, then commit
}, { timeout: 10_000, maxWait: 10_000 });
```
**Why:** Prisma's query builder has no FOR UPDATE / SKIP LOCKED support (verified); the supported way is `$queryRaw` inside an interactive `$transaction`, which also exposes the guarded `UPDATE`. Isolate it in one repository method (`src/processing/event-claim.ts`) and keep the transaction short (well under `lockDuration`).