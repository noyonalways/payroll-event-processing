# Payroll Event Processing — Architecture & Reliability

> **Status:** Implemented — all roadmap changes 2–13 are shipped and the CI pipeline
> (backend lint/typecheck/unit/build, frontend lint/vitest/build, full e2e against real
> Postgres + Redis service containers) is green on `main`.
>
> - Change 7 (`concurrency-and-crash-recovery`) ✅ — transactional row-locked
>   processing, `event_attempts`/`worker_heartbeats` tables, BullMQ stalled-job
>   recovery settings, worker liveness in `/health`.
> - Change 8 (`event-status-api`) ✅ — read-only `GET /events/:id` status + terminal
>   attempt trail (404 `ErrorResponseDto` on an unknown id).
> - Change 9 (`minimal-frontend`) ✅ — React/Vite demo UI with the `EMP-DEMO-*`
>   scenario lever (the mapping lives in `@repo/shared`,
>   `packages/shared/src/demo-scenarios.ts`).
> - Change 10 (`test-suite`) ✅ — test suites gated in CI (111 backend unit tests,
>   40 e2e, 52 frontend when shipped; the suite is now 187 / 66 / 78).
> - Change 11 (`ci-and-docs`) ✅ — `.github/workflows/ci.yml`, README, this document.
> - Change 12 (`multi-tenant-foundation`) ✅ — `organizations`/`users`/`memberships`/
>   `refresh_tokens`, an organization-scoped data path with tenant-qualified unique keys,
>   `POST /auth/*` + `GET /auth/me` behind a deny-by-default guard, tenant-qualified queue
>   job ids, and a migration with a conditional legacy-tenant backfill (§5 R8, §10 D6–D11).
> - Change 13 (`turborepo-workspace`) ✅ — the repository is now a pnpm + Turborepo
>   workspace: three deployable apps (`apps/api`, `apps/worker`, `apps/web`) and five
>   packages (`@repo/core`, `@repo/database`, `@repo/shared`, plus the eslint- and
>   typescript-config presets). Boundaries are enforced by the package manager
>   (`packages/core` holds both composition roots, so the e2e suites boot API + worker
>   from one package; `apps/web` imports the shared event-type contract); per-app
>   Dockerfiles build from the workspace root with app-filtered installs; CI runs turbo
>   tasks per member. Runtime behaviour unchanged — the 187 unit + 66 e2e + 78 frontend
>   tests are the same suites that gated the pre-move commit.
> - Change 14 (`events-list-api`) ✅ — read-only `GET /events` history: keyset-paginated
>   (`created_at DESC, id DESC` cursor), combinable validated filters, tenant-scoped by the
>   token's organization; the measured composite index behind it (§7.3a); the web UI's
>   history view replaces the localStorage tracked list (§7.3a).
>
> **Scope:** Full-system architecture + visual flows (roadmap changes 2–12; the workspace
> conversion is recorded in `openspec/changes/turborepo-workspace`).
> **Related:** The diagrams that illustrate this document (ERD, event flow, lifecycle
> state machine, system architecture) are on **Eraser**:
> <https://app.eraser.io/workspace/hIaUa8ZhdcDwT5YtdUiI>.

---

## 1. Context & goals

The service receives employee payroll events — `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`, `DEPARTMENT_CHANGE` — and processes them **asynchronously** so the HTTP response is fast and never blocked by (slow, occasionally failing) downstream work.

**Ground rules (from the assignment):**

- **Event submission** → authenticate → validate → persist → enqueue → fast `201` response.
- **Worker** picks events off a queue, runs a *simulated* external payroll operation that **occasionally fails**, records the outcome.
- No authentication *in the assignment baseline* (originally out of scope). **Change 12 (`multi-tenant-foundation`) adds it**: every route is authenticated by default and payroll data is scoped to an organization (§5 R8). Reliability and test quality remain the primary evaluation focus.

**Goals of this proposal:**

1. Give a single, reviewable picture of the whole system before code is written.
2. Make each of the 7 reliability requirements explicit: **where** it is enforced, and **how** it is enforced (plus the tenancy boundary added in change 12 — §5 R8).
3. Provide visual flows (architecture, lifecycle, sequence) that match the planned implementation 1:1.

## 2. Non-goals

- Authentication and multi-tenant isolation were **originally** out of scope and are now implemented (change 12). Still out of scope: database-level row security (isolation is application-enforced, §10 D6), role enforcement on endpoints, invitations / membership management, an employee directory (`employeeId` stays a tenant-local string), SSO/MFA, and a refresh-token retention sweep.
- No real payroll provider integration — the provider is simulated.
- No event bus fan-out to multiple consumers (single consumer group) — ordering guarantees are per-employee, not global.
- No Kubernetes / secrets management / TLS in this iteration.
- No at-least-once *delivery* to end customers — the demo frontend polls the status API.

## 3. System architecture (high level)

See the **System Architecture** diagram in eraser.io. In prose:

```
                    ┌────────────────────────────────────────────┐
   Browser ────────►│  NestJS API :3000                          │
   (React/Vite)     │  JwtAuthGuard — deny-by-default; the actor  │
                    │    (user, organization, role) comes from the│
                    │    signed access token, never the request   │
                    │  AuthController (POST /auth/*, GET /auth/me)│
                    │  EventsController (POST /events,         │
                    │    GET /events — read-only paginated     │
                    │    history, GET /events/:id — status)    │
                    │  EventsService: validate → dedupe →      │
                    │    persist → enqueue → status + history  │
                    │    reads — every tenant query filtered by│
                    │    the caller's org                      │
                    └───────┬─────────────────▲──────────────────┘
                            │ Prisma          │ 201 { id, status }
                 ┌──────────▼──────────┐   ┌──┴──────────────┐
                 │ PostgreSQL 16       │   │ Redis 7         │
                 │ organizations/users │   │ BullMQ          │
                 │ memberships/tokens  │   │ (jobs/retries)  │
                 │ payroll_events      │   │ tenant-qualified│
                 │ event_attempts      │   │ per-employee id │
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
                 │  every statement scoped by (id, organization)│
                 └──────────────┬──────────────────────────────┘
                                │ HTTP (simulated)
                 ┌──────────────▼──────────────┐
                 │ Simulated Payroll Provider  │
                 │ transient/permanent failures│
                 └─────────────────────────────┘
```

**Key components & responsibilities** — paths reflect the workspace layout (change 13):
the business logic lives in `@repo/core`, the outbound clients in `@repo/database`, and the
shared vocabulary in `@repo/shared`; `apps/api` and `apps/worker` are thin entrypoints around
their composition roots (design D4).

| Component | Responsibility | Reliability role |
|---|---|---|
| **HTTP API app** (`apps/api/`) | Entrypoint around the composition root in `@repo/core`: deny-by-default `JwtAuthGuard`; DTO validation (class-validator class-transformer), per-type validation rules, shared idempotency layer (`IdempotencyService` store-and-replay), persist + enqueue, and the read paths (paginated history + status) | Idempotency, fast response, tenant boundary |
| **Auth & tenancy** (`packages/core/src/auth/`) | Registration/login/refresh/logout, scrypt password hashing, `TokenService` (signed access JWT + hashed refresh rows), the guard that resolves `{ userId, organizationId, role }` from the token | Identity, tenancy boundary |
| **Redis / BullMQ** (connection in `@repo/database`, producer + FIFO semantics in `@repo/core`) | Job queue keyed per employee **within an organization** (tenant-qualified `jobId` → FIFO), delayed jobs for backoff, stalled-job detection | Ordering, retries, crash recovery |
| **Worker app** (`apps/worker/`) | Consumer entrypoint around the worker composition root in `@repo/core`: claim job, side-effect marker (`processing`), row lock, handler dispatch, provider call, transactional commit — all scoped by the job's organization | Exactly-once, concurrency, recovery, tenant isolation |
| **PostgreSQL / Prisma** (`packages/database/`) | `payroll_events` + `event_attempts` + `worker_heartbeats` + tenancy/identity tables, unique constraints, status transition guard, `SELECT … FOR UPDATE` (plain) row lock inside an interactive `$transaction` | Ground truth, atomicity, dedup, tenant ownership |
| **Simulated provider** (`packages/core/src/processing/`) | Random temp/perm failure (`PAYROLL_TEMPORARY_FAILURE_RATE`, `PAYROLL_PERMANENT_FAILURE_RATE`) | Testability of failure paths |
| **Demo UI** (`apps/web/`) | React/Vite two-pane app against the same API; the event list is the server-driven history (`GET /events`: filters, cursor load-more) with per-row status polling — imports the event-type contract and error-body shape from `@repo/shared` — a browser bundle with no database or queue client in it | Reviewer/demo surface |

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
- A shared NestJS idempotency layer (`packages/core/src/common/idempotency`, `idempotency_records` table) dedupes under `(organization, scope, key)`; the **`UNIQUE (organization_id, scope, key)`** constraint on the table is the DB's final arbiter. The organization is part of the identity because the key is client-chosen: a global key space would let two tenants pick the same value and the second would be served the first tenant's stored response body (§10 D7).
- On a miss, the submit operation and the record insert (`responseStatus`/`responseBody`/`expiresAt`) commit in the **same transaction**; duplicate submits replay the stored response with no new side effects. A rare race on the unique index is caught as a `P2002` constraint violation and treated as the same duplicate path (post-transaction winner read).
- Records are TTL'd (`IDEMPOTENCY_TTL_SECONDS`, default 86400 s) and swept (`IDEMPOTENCY_SWEEP_INTERVAL_MS`, default 60 s); an expired key is treated as absent — the expired row is deleted inside the transaction before the new insert.
- `payroll_events.idempotency_key` stays `NOT NULL` (non-unique) purely for traceability.
- **Enforced in:** `IdempotencyService.execute(organizationId, scope, key, op)` + `UNIQUE (organization_id, scope, key)` on `idempotency_records`. The organization is a required first argument, so a caller cannot run an idempotent operation without naming its tenant.

### R3 — Concurrency safety (multiple workers)
- Per-employee FIFO: the tenant-qualified BullMQ `jobId` (`perEmployeeJobId`, §5 R8) keeps jobs for one employee *within one organization* ordered, while different employees process in parallel.
- On top of the queue, the worker takes `SELECT … FOR UPDATE` on the event row inside the processing transaction (`event-claim.ts`), so two workers can never process the same event concurrently — the loser blocks on the lock, then its guarded claim (`WHERE status='queued'`) matches 0 rows and it applies no side effects (skip). The lock and the claim are both scoped by `organization_id`, so a job naming a valid foreign event id locks and mutates nothing.
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
- Monotonic `sequence` per employee **within an organization** (computed on insert under a tenant-qualified advisory lock), used for inspection/audit and tests.
- FIFO queue group by `(organization, employeeId)` (tenant-qualified `jobId`) → ordering guaranteed within an employee in that organization, parallelism across employees and across tenants.
- **Enforced in:** API persist (sequence) + queue producer (tenant-qualified `jobId`).

### R7 — Extensibility
- Handler strategy registry: `Map<EventType, PayrollHandler>`; a new event type = new DTO + new handler registered, no controller/service change.
- DTOs are per-type with their own required fields (see README table).
- **Enforced in:** `packages/core/src/processing/handlers` registry.

### R8 — Tenant isolation (multi-tenant foundation, change 12)
- **One owner per row, taken only from the token.** Every tenant-owned table carries a required `organization_id` (FK, `NOT NULL`, no default), and the organization always comes from the verified access token's `org` claim — `@CurrentActor()` in the controller, then a required first argument of the service (`EventsService.createEvent(organizationId, …)`, `EventClaimInput.organizationId`, `IdempotencyService.execute(organizationId, …)`). A request body field, query parameter, or header cannot steer it (§10 D6).
- **Deny by default.** `JwtAuthGuard` is registered as a global `APP_GUARD`, so every route is authenticated unless it declares `@Public()`. The only public routes are `GET /health`, the auth entry points (`/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`), and the API docs. Access tokens are single-purpose (`type: 'access'`), so a refresh token presented as a bearer token is rejected; all verification failures return one opaque `401`. Forgetting a guard produces a `401`, not a leak.
- **Every data-path statement is tenant-scoped.** The transactional claim (`SELECT … FOR UPDATE`, the guarded `queued → processing` update, the payload read, the terminal writes) filters by `(id, organization_id)`; the job data carries `organizationId`, so a forged job naming a valid foreign event id claims and mutates nothing. The relay's "next pending event for this employee" lookup is scoped to the job's organization, and the per-employee advisory lock is keyed on `${organizationId}:${employeeId}` — two tenants using the same employee number never serialize on each other.
- **Tenant-qualified queue job ids.** `perEmployeeJobId(organizationId, employeeId)` joins percent-encoded parts with `|` (e.g. `org-1|emp-1`). It must be tenant-qualified — employee numbers are tenant-local, and a bare `employeeId` would make two tenants share one BullMQ slot, letting one tenant's backlog suppress another's events — and it must avoid `:` because **BullMQ rejects a custom id containing a colon unless it splits into exactly three segments** (a legacy repeatable-job compatibility check). An earlier `<organizationId>:<employeeId>` form threw on every enqueue; the producer treats enqueue failure as non-fatal by design (the row is the source of truth), so the error was swallowed and events sat in `queued`. Percent-encoding both parts makes the mapping injective (§10 D10).
- **Cross-organization access reads as absence.** A foreign event id returns `404` with the same body as an unknown id, and the tenant-qualified idempotency key means a client-chosen key can never replay another tenant's stored response body.
- **Enforced in:** `packages/core/src/auth/` (guard, token/password services, `@CurrentActor`/`@Public`), the required `organizationId` arguments on `EventsService` / `IdempotencyService` / `EventClaim`, `perEmployeeJobId`, and the tenant-qualified unique keys/indexes; asserted end-to-end by `apps/api/test/tenant-isolation.e2e-spec.ts` (two organizations over real HTTP).

## 6. Data model

See the **ERD** in eraser.io. Eight tables: four for payroll processing, four for tenancy and identity.

**`payroll_events`** — one row per submitted event.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `organization_id` | UUID FK → `organizations` | **NOT NULL, no default** — the tenant discriminator; every read/write filters on it |
| `event_type` | enum/text | `BANK_ACCOUNT_CHANGE` \| `ADDRESS_CHANGE` \| `SALARY_CHANGE` \| `DEPARTMENT_CHANGE` |
| `employee_id` | text | tenant-local group key for ordering (two organizations may reuse a value) |
| `payload` | JSONB | validated event payload |
| `sequence` | bigint | per-employee monotonic counter, within the organization |
| `idempotency_key` | text | **NOT NULL** — traceability only, non-unique index |
| `status` | enum | `received` \| `queued` \| `processing` \| `success` \| `failed` |
| `created_at` / `updated_at` | timestamptz | |
| `processed_at` | timestamptz nullable | set on success |

**Constraints/indexes:** `UNIQUE (organization_id, employee_id, sequence)` (per-employee ordering does not cross tenants), index on `(organization_id, status)`, index on `(organization_id, employee_id, created_at)` — all tenant-leading, because every tenant-scoped query filters on the organization first — plus index on `idempotency_key`. The dedup response lives in `idempotency_records`, not on this row.

**`idempotency_records`** — store-and-replay dedup state for the shared idempotency layer, keyed by `(organization, scope, key)`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `organization_id` | UUID FK → `organizations` | the tenant the key was chosen in |
| `scope` | text | idempotency partition (e.g. `event-submission`) |
| `key` | text | client `Idempotency-Key` value |
| `response_status` | int | stored HTTP status returned to duplicates |
| `response_body` | jsonb | stored `201` body returned to duplicates |
| `expires_at` | timestamptz | TTL; swept and reused after expiry |
| `created_at` | timestamptz | |

**Constraints/indexes:** `UNIQUE (organization_id, scope, key)` — the dedup arbiter, scoped per tenant so a client-chosen key cannot replay another tenant's stored response body; index on `expires_at` for the sweep (`deleteMany(expires_at < now)`).

**`event_attempts`** — append-only audit trail of every attempt that ran, at most one row per `(event_id, attempt_number)` (`UNIQUE`). A transient failure appends its `FAILED(TEMPORARY)` row right after the claim transaction aborts; the terminal `SUCCESS` / `FAILED(PERMANENT)` row commits in the same transaction as the terminal `payroll_events` write (`AttemptStatus`/`AttemptErrorType` enums).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `event_id` | UUID FK → `payroll_events` (`ON DELETE CASCADE`) | indexed (`@@index([eventId])`); the real FK was added in change 12, so the trail cannot be orphaned and deleting an organization cascades to its attempts |
| `attempt_number` | int | 1-based; which attempt this row records · `UNIQUE (event_id, attempt_number)` — one row per attempt |
| `status` | enum | `SUCCESS` \| `FAILED` |
| `error_type` | enum nullable | `TEMPORARY` \| `PERMANENT` |
| `failed_reason` | text nullable | why it failed |
| `result` | JSONB nullable | provider result on success (== the event row's `result`) |
| `created_at` | timestamptz | when the attempt row was appended (a transient row right after the claim aborted; the terminal row at the terminal commit) |

**`worker_heartbeats`** — worker liveness for `/health` (D4). Intentionally NOT tenant-scoped: the worker fleet is shared infrastructure serving every organization.

| Column | Type | Notes |
|---|---|---|
| `worker_id` | text PK | stable worker id |
| `hostname` | text | |
| `started_at` | timestamptz | worker start time |
| `last_seen_at` | timestamptz | upserted every 5 s |

**Tenancy & identity (`organizations` / `users` / `memberships` / `refresh_tokens`)** — the model behind §5 R8 (§10 D6/D8).

| Table | Columns (essentials) |
|---|---|
| `organizations` | `id`, `name`, unique `slug` (derived from the name, disambiguated on collision). The tenant root every tenant-owned row points to. |
| `users` | `id`, unique lowercased `email`, `password_hash` (scrypt digest `scrypt$N$r$p$salt$hash`), optional `name`. Global — one person may belong to several organizations. |
| `memberships` | `user_id`, `organization_id`, `role` (`OWNER`/`ADMIN`/`MEMBER`), `UNIQUE (user_id, organization_id)`. The authority for "may this user act in this organization": the refresh path re-reads it, so removing a membership ends access within one access-token lifetime. |
| `refresh_tokens` | unique `token_hash` (SHA-256 digest — the token value is never stored), `user_id`, `organization_id` (the session's tenant), `expires_at`, `revoked_at`; indexed by `user_id`, `organization_id`, `expires_at`. |

**Migration & backfill (`20261015000000_multi_tenant_foundation`).** The migration runs in five parts: create the tenant/identity tables; seed the legacy organization *only if* `payroll_events` or `idempotency_records` already hold rows; add `organization_id` nullable, backfill it, then `SET NOT NULL` with no default; add the foreign keys (and the `event_attempts` → `payroll_events` FK, `ON DELETE CASCADE`); swap the unique keys for tenant-qualified ones and replace single-column indexes with tenant-leading ones. The legacy tenant is deterministic (id `00000000-0000-0000-0000-000000000001`, `Legacy Tenant` / `legacy`) and is created **only when there is pre-existing data to adopt**, so a fresh database never gets a phantom organization. It has no members: nobody can sign in as it, so its rows must be reassigned (or administered directly) as a deliberate operational step. The schema change is not reversible in place (the `NOT NULL` discriminator and replaced unique keys); rollback means restoring a pre-migration backup. The deploy order and queue caveat are in `openspec/changes/multi-tenant-foundation/design.md` (Migration Plan).

**Note:** `idempotency_key` is `NOT NULL` + non-unique index (D1), and dedup state lives in `idempotency_records` — the ERD in eraser.io is updated to match.

## 7. Sequence flows

The core pipeline flows (submission, processing, status read) are visualized in a single end-to-end sequence diagram in eraser.io; §7.4 is documented in prose and in `openspec/changes/multi-tenant-foundation/design.md`.

### 7.1 Event submission (idempotent, non-blocking)

1. `Client → POST /events` with `Authorization: Bearer <accessToken>`, `Idempotency-Key` + typed payload. The global guard resolves the actor; the organization is taken from the token's `org` claim (`@CurrentActor()`) and never from the request.
2. API validates DTO → `400` on invalid; missing/blank key → `400` (`@IdempotencyKey()`); missing/invalid/expired token → `401` before any handler runs.
3. `IdempotencyService.execute(organizationId, 'event-submission', key, op)` — fast-path `findUnique` on `(organization, scope, key)`; **record found & unexpired → return stored response** (no new side effects).
4. On miss, one transaction: delete any still-expired `(organization, scope, key)` row, take the per-employee advisory lock (keyed `${organizationId}:${employeeId}`), compute the next `sequence` within the organization, insert `payroll_events(status=received, organization_id)` **and** the `idempotency_records` row together (a `P2002` race on the tenant-qualified unique key → post-transaction winner read → duplicate path → stored response).
5. Enqueue a BullMQ job carrying the organization, with the tenant-qualified `jobId`; mark `queued`.
6. Return `201 { id, status: 'received' }`. HTTP returns within milliseconds; provider work happens later.

### 7.2 Worker processing (exactly-once, retry, recovery)

1. Worker fires for a claimed job; the `received → queued` ensure (relay make-safe) runs **outside** the claim transaction, scoped by `(id, organizationId)` from the job data, then `HeartbeatService.touch()` bumps the worker liveness row.
2. **ONE interactive transaction** (`event-claim.ts`, `{ timeout: 10_000, maxWait: 5_000 }`):
   a. **Concurrency lock:** `SELECT id FROM payroll_events WHERE id=? AND organization_id=? FOR UPDATE` (`$queryRaw` — Prisma has no FOR UPDATE builder). Scoping the lock by tenant means a forged or corrupt job naming a valid foreign event id locks nothing.
   b. **Guarded claim:** `UPDATE payroll_events SET status='processing' WHERE id=? AND organization_id=? AND status='queued'` — 0 rows → stale/duplicate (or foreign), skip with no side effects.
   c. **Payload read** inside the tx (the DB row stays the source of truth), then dispatch through the handler registry.
3. **Success** → commit `[event → success + result/processed_at + attempt → SUCCESS w/ result]` → ack job.
4. **Transient failure** → re-throw inside the tx → **ABORT** → the claim rolls back to `queued` (no explicit reset) and the attempt's `FAILED(TEMPORARY)` audit row is appended outside the aborted transaction → BullMQ schedules the retry with exponential backoff.
5. **Permanent failure** → commit `[event → failed + attempt → FAILED(PERMANENT, reason)]`, no retry (dead-letter).
6. **Retries exhausted** (transient) → `onFailed` array `$transaction` commits `[queued → failed]` + upserts the final attempt's `FAILED(TEMPORARY)`, reason row — idempotent with the row the last transient failure already appended. The `queued → failed` update is scoped by `(id, organizationId)` too.
7. **Crash anywhere** between lock and commit → the transaction aborts → the row is back in `queued` (never stuck in `processing`); BullMQ stalled-job detection additionally re-queues a job whose worker died mid-work, and a fresh worker reprocesses safely thanks to the guarded claim + terminal status guard.
8. **Relay (on BullMQ's `completed`)** → the worker looks up the next non-terminal row for the same `(organization, employee)` in ascending `sequence` and re-enqueues it with the same tenant-qualified `jobId`. The lookup is constrained to the job's organization, so a completion in one tenant never schedules another tenant's event.

### 7.3 Read-only status (`GET /events/:id`, event-status-api)

The status endpoint is a READ-ONLY pair of sequential reads inside the caller's
organization — no `Idempotency-Key`, no mutation.

1. Client → `GET /events/:id` with `Authorization: Bearer <accessToken>`. The event is looked
   up by `(id, organization_id)`, where the organization comes from the token. An event that
   belongs to a different organization and an id that does not exist are reported identically:
   `NotFoundException`, shaped by the global `HttpExceptionFilter` into the documented 404
   `ErrorResponseDto`. A `403` would confirm the id exists elsewhere, so the API never emits one
   for this case.
2. `event_attempts` trail fetched `WHERE eventId = :id ORDER BY attemptNumber ASC`
   and re-sorted at the boundary — the response's `attempts[]` is always ascending
   regardless of store order. (The trail is reached only through an event id that has already
   passed the tenant-scoped lookup, so it needs no `organization_id` of its own.)
3. Response `200 EventStatusResponseDto`: committed `status` (lowercase wire format:
   `received`|`queued`|`processing`|`success`|`failed`), event details, `sequence`
   coerced `BigInt → Number` (never a raw BigInt on the wire), `processedAt`/`result`
   on `success`, null otherwise, and one `EventAttemptDto` per attempt with
   `attemptNumber`/`status`/`errorType`/`failedReason`/`result`/`createdAt`.

The reported `status` always mirrors the committed `payroll_events` row: because the
claim is rolled back on any abort, polling between BullMQ retry attempts observes
`queued` with the attempts that have already run on the trail — never a stuck
`processing`.

### 7.3a Read-only event history (`GET /events`, events-query-api)

The list endpoint is the other read path — READ-ONLY by construction (one `findMany`,
no create/update/delete call exists on it, nothing enqueued), so listing history can
never affect lifecycle state. Both reads live beside each other in `EventsService`
and take the caller's organization as their required first argument, so the tenant
boundary cannot diverge between them.

1. Client → `GET /events?status=&eventType=&employeeId=&createdAfter=&createdBefore=&limit=&cursor=`
   with `Authorization: Bearer <accessToken>`. The query DTO is validated
   deny-by-default — every accepted parameter is declared, so an undeclared query
   parameter, an unknown status/eventType, a malformed date, or `limit` outside 1–100
   is a structured `400` via the global pipe and filter.
2. ONE `findMany` over `payroll_events`: `WHERE` composed with AND — `organization_id`
   from the token plus any filters — `ORDER BY created_at DESC, id DESC`, `LIMIT page+1`.
   The projection is narrow (id, type, employee, sequence, status, timestamps): payload,
   result, and the attempt trail are the single-event contract, and leaving them out
   keeps 100-row pages light.
3. **Keyset pagination** (design D1): `nextCursor` is a versioned
   (`{v,t,i}`) base64url token carrying the last row's `(created_at, id)`; a
   continuation seeks strictly after that position — `createdAt < t OR (createdAt = t
   AND id < i)` — so pages never shift while new events arrive (unlike offset
   pagination), and burst rows sharing one timestamp cannot both be "next". An
   undecodable cursor is a `400`, never silently page one.
4. The composite index `(organization_id, status, created_at DESC, id DESC)` (added by
   migration `20261015180615`, measured in `index-measurements.md`) turns the
   status-filtered pages — the UI's common view — into pure index scans that read
   exactly the requested rows with no sort at any page depth.

### 7.4 Authentication & session flows (multi-tenant foundation, change 12)

**Register** — `POST /auth/register { email, password, organizationName, name? }`: one
transaction creates the organization (slug derived from the name and disambiguated on collision,
so two companies may share a display name), the user (scrypt digest), and an `OWNER` membership.
A duplicate email is `409`; a password shorter than 12 characters is `400`. The returned session
is scoped to that new organization. There is deliberately no way to join an existing
organization — that needs an invitation (a later change).

**Login** — `POST /auth/login { email, password, organizationId? }`: the password is verified in
constant time against the stored digest; an unknown email still runs a throwaway verification so
the two paths cost the same. An account in exactly one organization signs in directly; an
account in several must name `organizationId` (`400` otherwise, rather than an arbitrary tenant
being chosen). Bad credentials, an unknown email, and an organization the account does not belong
to all return the same opaque `401` (§10 D9).

**Session** — register/login/refresh each return
`{ accessToken, refreshToken, tokenType, expiresIn, refreshExpiresAt, user, organization, role }`.
The access token is an HS256 JWT carrying `{ sub, org, role, type: 'access' }`, valid for
`AUTH_ACCESS_TOKEN_TTL` (default 15 m); the guard verifies it statelessly and attaches the actor
to the request. The refresh token is 256 bits of randomness, stored only as a SHA-256 digest
alongside the session's organization.

**Refresh** — `POST /auth/refresh { refreshToken }`: `TokenService.rotate` consumes the presented
row (revokes it), the service re-reads the membership — so a removed member cannot refresh — and
a new pair is issued for the same organization. Presenting an already-consumed token is treated
as reuse and revokes every live refresh token for that user. Every failure path is the same
opaque `401` (§10 D8).

**Logout** — `POST /auth/logout { refreshToken }` revokes the presented token and always answers
`204`, even for an unknown or already-revoked value: a client can clear its session locally
without error handling, and the response cannot be used to probe whether a token was real.

**Public routes** — only `GET /health`, the four `/auth/*` entry points above, and the API docs
(`/api-docs`, `/api-docs-json`) skip the guard. Everything else, including `GET /auth/me`, needs
a bearer token.

## 8. Failure modes & recovery

| Failure | Observable effect | Recovery |
|---|---|---|
| Provider down (all attempts) | row returns to `queued` between retries, ends `failed` | tx abort on transient; exhausted → `failed` w/ reason, dead-letter |
| Business/validation error from provider | attempt `error_type=PERMANENT` | event `failed` (tx), never retried |
| Worker crashes mid-processing | transaction never commits | tx abort rolls the row back to `queued`; stalled-job detection re-queues → reprocess (guarded) |
| Duplicate client submit (same key) | second `POST` | idempotency short-circuit returns stored `201` |
| Duplicate submit race (concurrent) | unique constraint violation | caught → treated as duplicate |
| Two workers same event | both claim same job row | `FOR UPDATE` row lock + guarded claim → only one proceeds |
| Missing / invalid / expired / foreign-signed access token | `401` on any protected route | no handler runs; the client refreshes or signs in again |
| Refresh token presented as an access token | `401` | guard requires `type='access'` in the verified claims |
| Foreign event id (exists in another organization) | `404`, identical to an unknown id | none — deliberate: the API must not confirm the id exists elsewhere |
| Job naming a foreign organization's event | claim matches 0 rows | no lock, no mutation, no attempt row — the tenant is part of the claim's `WHERE` |
| Consumed refresh token replayed | `401`; every live refresh token for that user revoked | the legitimate client signs in again; the copied token is dead |
| Access token outlives a removed membership | usable until expiry (≤ 15 m by default) | refresh re-reads the membership row and refuses; recorded limitation (§10) |
| Invalid payload | — | `400` at submission, nothing persisted |
| Demo scenario id (`EMP-DEMO-*`, see `packages/shared/src/demo-scenarios.ts`) | forced outcome per submission: success, `failed`/`PERMANENT` (attempt 1), transient retries → `failed`/`TEMPORARY` (every attempt), transient-then-success (attempt 3), or transient-then-permanent (attempt 3, `FAILAFTER`) | deterministic override, wins over `PAYROLL_FAILURE_MODE`; reviewer lever for the demo UI — each attempt is recorded on the audit trail |

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
| 10 `test-suite` ✅ | unit + e2e incl. recovery + frontend Vitest (111 / 40 / 52 when shipped; 233 / 83 / 84 today) |
| 11 `ci-and-docs` ✅ | `.github/workflows/ci.yml` (backend + frontend + e2e jobs), README + this doc — Swagger/OpenAPI delivered early by `swagger-openapi` (UI /api-docs, JSON /api-docs-json) |
| 12 `multi-tenant-foundation` ✅ | `organizations`/`users`/`memberships`/`refresh_tokens`; required `organization_id` on `payroll_events` + `idempotency_records` with tenant-qualified unique keys and tenant-leading indexes; `POST /auth/register\|login\|refresh\|logout` + `GET /auth/me` (short-lived access JWTs, single-use rotating refresh tokens); deny-by-default guard scoped by the token's organization; tenant-qualified queue job ids; backfilling migration with a conditional legacy tenant; frontend sign-in + transparent refresh |
| 13 `events-list-api` ✅ | `GET /events` — read-only, tenant-scoped, keyset-paginated (`created_at DESC, id DESC` cursor) event history with combinable validated filters; measured composite index `(organization_id, status, created_at DESC, id DESC)` (§7.3a); web UI history view replaces the localStorage tracked list (§7.3a read-model note: the server list is the only source; reloads re-fetch, sessions re-scope) |

## 10. Decisions (closed — implementation-ready)

All previously open items are now settled with concrete values.

### D1 — `idempotency_key`: `NOT NULL` + non-unique index (confirmed, revised in `idempotency-layer`; tenant-qualified in change 12)
Required `Idempotency-Key` header; dedup is enforced by `UNIQUE (organization_id, scope, key)` on the dedicated `idempotency_records` table (the organization joined the key in change 12, §10 D7); `payroll_events.idempotency_key` stays `NOT NULL` (indexed) purely for traceability. A nullable key cannot guarantee dedup.

### D2 — Stored response on dedupe: dedicated `idempotency_records` table, TTL'd + swept (no Redis cache)
The shared idempotency layer keeps one row per `(organization, scope, key)` holding `response_status` + `response_body`, written in the **same insert transaction** as the business row. Duplicate/key-reuse submits read that row and return exactly the stored response; records expire (`IDEMPOTENCY_TTL_SECONDS`) and are swept (`IDEMPOTENCY_SWEEP_INTERVAL_MS`), and an expired key becomes reusable.
**Why:** the DB is already the dedup arbiter via `UNIQUE (organization_id, scope, key)`, so correctness never depends on a TTL'd cache; a Redis cache would only add eviction + coherence failure modes. The separate table keeps the dedup state independent of the business row and is generic across scopes. This supercedes the earlier design that stored the response on the `payroll_events` row (columns removed in the `idempotency_records` migration).

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
**Why:** Prisma's query builder has no FOR UPDATE support (verified); the supported way is `$queryRaw` inside an interactive `$transaction`, which also exposes the guarded `UPDATE`. Plain `FOR UPDATE` (not `SKIP LOCKED`) is correct here because the second contender blocks, then its guarded claim matches 0 rows and it skips — every job still gets one definitive verdict. Isolated in `packages/core/src/processing/event-claim.ts`; the transaction stays short (well under `lockDuration`), and a transient failure re-throw aborts it with **no explicit `processing → queued` reset** — the rollback IS the reset, so a crash at any point also leaves the row claimable (R4). (Since change 12, this lock, the guarded claim, and every other statement in the transaction are additionally scoped by `organization_id` — §5 R8 / §10 D6. The snippet above shows the pre-tenancy shape.)

### D6 — Shared schema with an `organization_id` discriminator (change 12, `multi-tenant-foundation`)
One database, one migration history, an `organization_id` column on every tenant-owned table, and the organization as a **required argument** of every tenant-scoped method: `EventsService.createEvent(organizationId, …)`, `EventClaim.claimAndProcess({ organizationId, … })`, `IdempotencyService.execute(organizationId, …)`. The organization is read only from the verified access token's `org` claim — never from a body field, query parameter, or header — so a caller cannot widen their boundary by editing the request.
**Alternatives:** *schema-per-tenant* / *database-per-tenant* (stronger isolation, but migration work multiplies by tenant count, pooling gets complicated, and the worker's cross-row relay plus the shared idempotency store would need reworking); a *Prisma client extension* injecting the filter automatically (cannot cover the raw `SELECT … FOR UPDATE` / `pg_advisory_xact_lock` statements, so the most safety-critical queries would stay manual — a partial guarantee is worse than an explicit one); `AsyncLocalStorage` (implicit, harder to test); **PostgreSQL RLS** (strongest, but needs a per-request `SET LOCAL` that conflicts with pooling unless every transaction sets it). Isolation is asserted by e2e tests that register a second organization (`apps/api/test/tenant-isolation.e2e-spec.ts`); RLS remains the planned defence-in-depth follow-up, so the boundary is application-layer today.

### D7 — The organization is a component of the idempotency key
`UNIQUE (scope, key)` became `UNIQUE (organization_id, scope, key)`, and `execute()` takes the organization as its first argument.
**Why:** this is not only a deduplication concern. With a global key space, two organizations that happened to choose the same client-supplied key value would collide, and the second caller would be served the **first organization's stored response body** — a data leak, not merely a spurious duplicate. Making the organization a required parameter (rather than prefixing the scope string at the call site) means a future endpoint cannot adopt the layer and forget the tenant.

### D8 — Stateless access tokens, revocable hashed refresh tokens, rotation with reuse detection
The access token is a short-lived signed JWT carrying `{ sub, org, role, type: 'access' }`, so the guard needs no database round-trip and tenant identity is tamper-proof. The refresh token is an opaque 256-bit random value stored only as a SHA-256 digest, which is what makes revocation possible at all; a refresh consumes its row and issues a new pair, and presenting an already-consumed token revokes every live refresh token for that user (reuse detection — the legitimate client signs in again, the copy is dead). The refresh path re-reads the membership row, so a removed membership stops working at the next refresh rather than at access-token expiry.
**Alternatives:** long-lived JWTs only (cannot be revoked); server-side sessions in Redis (adds a dependency read to every request and a new failure mode); an access-token denylist (reintroduces the per-request lookup that stateless tokens exist to avoid). **Cost:** a removed membership stays usable until the access token expires, which is why the TTL is deliberately short (default 15 m) — see the recorded limitations below.

### D9 — Cross-organization reads are `404`, not `403`
An event id that exists in another organization is reported exactly like an id that does not exist. A `403` would confirm the row exists, letting an authenticated tenant enumerate other tenants' identifiers. The same reasoning is applied to login: a wrong password, an unknown email, and an organization the account is not a member of all produce the same `401` with comparable timing (the unknown-email path runs a throwaway digest verification), so the endpoint cannot be used to probe which accounts or organizations exist.

### D10 — Queue job identity is tenant-qualified, and BullMQ's colon rule
`perEmployeeJobId` joins percent-encoded parts with `|` (`org-1|emp-1`). BullMQ's per-`jobId` suppression is what implements per-employee FIFO, and employee ids are tenant-local, so a bare `employeeId` would make two organizations share a slot — one tenant's backlog would suppress and delay another's events.
**The hard-won constraint:** BullMQ **rejects a custom id containing `:` unless it splits into exactly three segments** (a legacy repeatable-job compatibility check). An earlier `<organizationId>:<employeeId>` form therefore threw on *every* enqueue, and because the producer treats enqueue failure as non-fatal by design (the row is the source of truth), the error was swallowed and events sat in `queued`. The id was changed to a colon-free `|` join, and percent-encoding both parts makes the mapping injective by construction: distinct (organization, employee) pairs can never collapse onto one id and silently suppress a submission (asserted by the unit spec).
**Alternatives:** one queue per organization (clean isolation, but dynamic queue names complicate worker registration); a BullMQ group/priority scheme (heavier than needed); a hash of the pair (opaque, and collisions would be silent).

### D11 — Password hashing on Node's built-in scrypt
`node:crypto.scrypt` with N=2^15, r=8, p=1, a 16-byte random salt, and self-describing digests (`scrypt$N$r$p$salt$hash`) so cost parameters can be raised later without invalidating stored credentials; the parameters are bounded when reading a digest so a corrupt or hostile row cannot demand an absurd `N`.
**Alternatives:** `argon2` (the modern recommendation, but a native module in the `node:20-alpine` runtime images — build toolchain or per-platform prebuilt gamble), `bcrypt`/`bcryptjs` (native, or pure-JS and slow). scrypt ships in the platform, is OWASP-accepted, behaves identically on host and in the container, and adds no dependency.

**Recorded limitations (change 12).**
- **Isolation is application-layer, not database-enforced.** There is no Postgres RLS; the guarantee rests on the required `organizationId` argument, tenant-leading indexes, and the isolation e2e tests. RLS is the planned hardening follow-up (D6).
- **No refresh-token retention sweep yet.** Expired/revoked rows are revocable and indexed by `expires_at`, but nothing garbage-collects them on a schedule (a sweep mirroring the idempotency sweeper is a small follow-up).
- **Access tokens are revocable only by expiry.** There is no denylist, so a removed membership or a leaked token stays usable for at most one access-token lifetime; the refresh path re-checks the membership.
- **Not implemented, by design:** database-level RLS, invitations or membership administration, role enforcement on endpoints, an employee directory (`employeeId` remains a tenant-local string), SSO/MFA/password reset, and any user-management UI beyond signing in.