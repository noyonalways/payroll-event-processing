# Payroll Event Processing Service

Backend Engineering Technical Assignment — a production-oriented, reliable **asynchronous payroll event processing service**.

Built with **NestJS + TypeScript + PostgreSQL + Redis + BullMQ + Docker + GitHub Actions**.

[![CI](https://github.com/noyonalways/payroll-event-processing/actions/workflows/ci.yml/badge.svg)](https://github.com/noyonalways/payroll-event-processing/actions/workflows/ci.yml)

> **Status:** Implemented. The full stack (API + worker + Postgres + Redis + demo UI) runs
> together, the reliability layer is in place, and a three-job CI pipeline gates `main`.
> The `docs/architecture.md` file has the complete design narrative with every reliability
> requirement mapped to its enforcement point.

---

## Table of contents

- [What it does](#what-it-does)
- [Quick start (Docker)](#quick-start-docker)
- [Architecture](#architecture)
- [Installation (running on the host)](#installation-running-on-the-host)
- [Environment variables](#environment-variables)
- [Database setup & migrations](#database-setup--migrations)
- [Starting the API](#starting-the-api)
- [Starting the worker](#starting-the-worker)
- [Running the demo UI](#running-the-demo-ui)
- [Running tests](#running-tests)
- [Database design](#database-design)
- [Background processing design](#background-processing-design)
- [Engineering decisions & trade-offs](#engineering-decisions--trade-offs)
- [API documentation (Swagger/OpenAPI)](#api-documentation-swaggeropenapi)
- [Project structure](#project-structure)

---

## What it does

The service receives employee payroll-related events (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`,
`SALARY_CHANGE`, `DEPARTMENT_CHANGE`), persists them, and processes them **asynchronously** in the background so the
HTTP request returns within milliseconds — it never blocks on processing work.

Event submission → validate → idempotency check → persist → enqueue → fast `201` response.
A separate worker picks events off a queue, runs a *simulated* external payroll operation
(which occasionally fails), and records the outcome. Clients track progress through a
read-only status endpoint (or the demo UI, which polls it).

### Supported event types

| Event | Required fields |
|---|---|
| `BANK_ACCOUNT_CHANGE` | `employeeId`, `effectiveDate`, `iban` |
| `ADDRESS_CHANGE` | `employeeId`, `effectiveDate`, `street`, `city`, `postalCode`, `country` |
| `SALARY_CHANGE` | `employeeId`, `effectiveDate`, `newSalary`, `currency` |
| `DEPARTMENT_CHANGE` | `employeeId`, `effectiveDate`, `newDepartment` |

> Adding a new event type is a drop-in: new enum member + payload DTO + handler, each registered in
> one line (`PayloadDtoRegistry`, `HandlerRegistry`). No schema migration (payload is JSONB), no
> controller/service/worker changes.

Event lifecycle: `received → queued → processing → success | failed` (with a per-attempt audit trail).

### API surface

| Endpoint | Description |
|---|---|
| `POST /events` | Submit an event. Requires the `Idempotency-Key` header. Returns `201` with the stored response (duplicates replay it). |
| `GET /events/:id` | Read-only event status: committed lifecycle state, details, and the attempt history (one row per attempt). `404` for unknown ids. |
| `GET /health` | Service health: DB + Redis reachability, worker liveness heartbeats, BullMQ stalled-job count. Always `200`; the body carries `status: ok \| degraded`. |
| `GET /api-docs` | Swagger UI (interactive). Raw spec at `/api-docs-json`. |

---

## Quick start (Docker)

Requires Docker + Docker Compose.

```bash
# The api/worker services read .env.development as their env_file, and it is
# gitignored — create it from the template before the first run.
cp .env.example .env.development
#   PowerShell: Copy-Item .env.example .env.development

docker compose up --build
```

This starts five containers (data is kept in a named `pgdata` volume):

| Service | Container | Port |
|---|---|---|
| `postgres` | `payroll_postgres` | `5432` (Postgres 16) |
| `redis` | `payroll_redis` | `6379` (Redis 7) |
| `api` | `payroll_api` | `3000` |
| `worker` | `payroll_worker` | — |
| `frontend` | `payroll_frontend` | `5173` (nginx-served demo UI) |

The API image's entrypoint runs `prisma migrate deploy` before starting, so migrations are
applied automatically. The worker starts only after the API is healthy (its `depends_on`).

- Demo UI: http://localhost:5173
- API health: http://localhost:3000/health
- Swagger: http://localhost:3000/api-docs

Send a first event to see the pipeline move end-to-end:

```bash
curl -s -X POST http://localhost:3000/events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: smoke-1' \
  -d '{"eventType":"BANK_ACCOUNT_CHANGE","payload":{"employeeId":"EMP-001","effectiveDate":"2026-09-01","iban":"DE89370400440532013000"}}'
```

Tear everything down with `docker compose down` (add `-v` to also drop the `pgdata` volume).

---

## Architecture

```
                ┌──────────────────────────────────────────────┐
                │  Client: demo UI (:5173) · curl · Swagger     │
                └──────────────────────┬───────────────────────┘
                                       │ POST /events (Idempotency-Key)
                                       │ GET /events/:id · GET /health
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  NestJS API  (:3000)                          │
                │  validate → idempotency → persist → enqueue   │
                └───────┬──────────────────────────────┬────────┘
                 Prisma │ (DB is the source of truth)  │ BullMQ add
                        │                              │ jobId = employeeId
                        ▼                              ▼
         ┌──────────────────────────┐      ┌───────────────────────────┐
         │  PostgreSQL 16           │      │  Redis 7                  │
         │  payroll_events          │◄─────│  payroll-events queue     │
         │  event_attempts          │ claim│  (FIFO per employee,      │
         │  idempotency_records     │      │   retries with backoff)   │
         │  worker_heartbeats       │      └────────────┬──────────────┘
         └───────────▲──────────────┘                   │ consumer
                     │ transactional                     ▼
                     │ claim + terminal write   ┌───────────────────────────────┐
                     └───────────────────────── │  BullMQ Worker  (apps/worker) │
                                               │  claim (SELECT … FOR UPDATE) → │
                                               │  handler → simulated provider  │
                                               │  retry/backoff · relay · beats │
                                               └───────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| **NestJS API** (`src/`) | DTO validation (class-validator), per-type payload rules, the shared idempotency layer, persist + enqueue, read-only status, `/health`. |
| **Redis / BullMQ** | `payroll-events` job queue. `jobId = employeeId` makes it FIFO per employee while other employees run in parallel. Delayed jobs implement backoff; stalled-job detection recovers crashed workers. |
| **BullMQ Worker** (`apps/worker/`) | Claims a job, takes the DB row lock inside a single transaction, dispatches to the per-type handler, and commits the terminal state + audit row atomically. |
| **PostgreSQL / Prisma** | Ground truth for event state, idempotency, attempt history, and worker liveness. Unique constraints + the row lock make the guarantees hold even with multiple workers. |
| **Simulated provider** (`src/processing/`) | Fake external payroll call with env-tunable transient/permanent failure rates; deterministic `EMP-DEMO-*` scenarios for review demos. |
| **Demo UI** (`frontend/`) | React + Vite two-pane app: submit an event, watch it progress through live polling, inspect detail + failure trail. |

Interactive diagrams (ERD, event flow, lifecycle state machine, system architecture) are
hosted on **Eraser**: <https://app.eraser.io/workspace/hIaUa8ZhdcDwT5YtdUiI>. Visual-only —
the prose below and **`docs/architecture.md`** stay the source of truth.

The full design narrative — the seven reliability requirements mapped to enforcement points,
sequence flows, and every decision record — lives in **`docs/architecture.md`**.

---

## Installation (running on the host)

Recommended for development and for running tests. The database and Redis below are the only
infrastructure needed; everything else runs as Node processes.

**Prerequisites**

- Node.js ≥ 20 (the backend resolves all engines on 20; Node 22 is needed for the frontend's
  Vitest suite — see the CI note). A current LTS installs both via `npx` if you prefer.
- npm ≥ 10
- Docker (optional — only for Postgres/Redis containers or the full compose stack)

**Steps**

```bash
# 1. Install dependencies
npm ci

# 2. Generate the Prisma client (needed before the app or tests can run)
npx prisma generate

# 3. Create your local env files — NestJS loads `.env.<NODE_ENV>` at runtime, and
#    the Docker stack uses `.env.development` as its env_file, so copy the
#    template for the stages you plan to run
cp .env.example .env.development
cp .env.example .env.test
#   PowerShell: Copy-Item .env.example .env.development

# 4. The Prisma CLI reads ONLY a root `.env`. Create it with a DATABASE_URL and
#    keep it in sync with .env.development (gitignored — see "Why the split")
cp .env.development .env
#   PowerShell: Copy-Item .env.development .env
```

Now bring up the infrastructure. If you have Docker:

```bash
docker compose up -d postgres redis
```

Or run Postgres/Redis however you prefer (a local install, Homebrew, etc.) and keep the
`localhost` values in `.env.development`.

---

## Environment variables

The app is configured entirely through environment variables. NestJS `ConfigModule`
auto-loads **`.env.<NODE_ENV>`** (`.env.development`, `.env.test`, …); `NODE_ENV` selects the
file. In the Docker stack, `docker-compose.yml` overrides the two topology vars
(`DATABASE_URL`, `REDIS_HOST`) with compose-network service names.

**.env template:** `.env.example` — copy to `.env.development` / `.env.test` and adjust.

**Why the `.env` / `.env.<NODE_ENV>` split:** the **Prisma CLI** (`migrate`, `studio`) loads
only a root `.env` and has no `--env-file` flag, while the running app never reads that root
file — it reads `.env.<NODE_ENV>`. So the root `.env` exists *solely* so Prisma commands work
without exporting variables by hand; keep its `DATABASE_URL` in sync with
`.env.development`.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Picks the `.env.<NODE_ENV>` file. |
| `PORT` | `3000` | API listen port. |
| `LOG_LEVEL` | `log` | NestJS logger level (`error`\|`warn`\|`log`\|`debug`\|`verbose`), applied at bootstrap to both API and worker. `log` shows the review arc; `debug`/`verbose` re-enable per-event relay breadcrumbs. |
| `DATABASE_URL` | `postgresql://payroll:payroll@localhost:5432/payroll?schema=public` | Prisma connection string. |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | BullMQ connection. |
| `PAYROLL_TEMPORARY_FAILURE_RATE` | `0.25` | Probability a simulated call fails transiently (retried). |
| `PAYROLL_PERMANENT_FAILURE_RATE` | `0.05` | Probability it fails permanently (business rejection, not retried). |
| `PAYROLL_FAILURE_MODE` | `random` | Deterministic override for tests: `random` \| `always-success` \| `always-transient` \| `always-permanent`. |
| `PAYROLL_MAX_RETRY_ATTEMPTS` | `5` | BullMQ attempts per job before the event is permanently failed. |
| `PAYROLL_RETRY_BASE_DELAY_MS` | `1000` | Exponential-backoff base; delay = base × 2^(attempt−1) → 1 s, 2 s, 4 s, 8 s. |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | How long a stored idempotency response stays valid before the key is reusable. |
| `IDEMPOTENCY_SWEEP_INTERVAL_MS` | `60000` | Sweep cadence for expired idempotency records. |
| `PAYROLL_WORKER_LOCK_DURATION_MS` | `30000` | BullMQ lock duration — must exceed the processing transaction (10 s) so a healthy worker never false-stalls. |
| `PAYROLL_WORKER_STALLED_INTERVAL_MS` | `30000` | Re-queue interval for jobs whose worker died. |
| `PAYROLL_WORKER_MAX_STALLED_COUNT` | `1` | Times a stalled job is re-queued before being failed. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `5000` | Worker liveness upsert cadence into `worker_heartbeats`. |
| `HEALTH_WORKER_STALE_MS` | `15000` | `/health` marks a worker stale when its heartbeat is older than this. |
| `WORKER_ID` | *(none)* | Optional stable worker id; defaults to `${hostname}:${pid}`. |

---

## Database setup & migrations

All schema changes live in `prisma/migrations/` and are applied with Prisma Migrate.
Four tables: `payroll_events`, `idempotency_records`, `event_attempts`, `worker_heartbeats`
(see [Database design](#database-design)).

```bash
# Apply all pending migrations (idempotent; safe on any environment, incl. CI)
npx prisma migrate deploy

# During development, create the next migration from a schema.prisma edit
npx prisma migrate dev --name describe_the_change

# Inspect data / schema interactively
npx prisma studio
```

- **Local / CI:** `migrate deploy` applies the committed migrations in order — it never
  generates new ones and never needs a shadow database.
- **Docker stack:** the API entrypoint runs `migrate deploy` automatically on first start.
- **Prisma CLI access:** the CLI needs a root `.env` with `DATABASE_URL` (see the split note
  above). For a non-local stage, pass the URL inline instead:
  `$env:DATABASE_URL = '<url>'; npx prisma migrate status`.

---

## Starting the API

```bash
# Development (watch mode) — needs .env.development + Postgres + Redis up
npm run dev

# Production-style: build then run the compiled output
npm run build
npm run start
```

Confirm it is up: http://localhost:3000/health (should report `status: "ok"` once a worker is
running too), Swagger at http://localhost:3000/api-docs.

Submit one of the sample payloads under **Demo scenarios** in the UI, or via Swagger's "Try
it out" (remember the `Idempotency-Key` header).

---

## Starting the worker

The API only enqueues jobs — a worker process must consume them for events to progress past
`queued`.

```bash
# Development (watch mode)
npm run dev:worker

# Production-style
npm run build:worker
npm run start:worker
```

You should see lifecycle lines like `Processing BANK_ACCOUNT_CHANGE event … (attempt 1, worker …) — started`
and the terminal verdict. The default `LOG_LEVEL=log` keeps the arc clean; set
`LOG_LEVEL=verbose` to also see `Enqueued …` / `Relaying next …` breadcrumbs.

In the Docker stack the worker is `worker` and starts automatically; `/health` proves it by
listing the worker heartbeat.

---

## Running the demo UI

```bash
# Host dev (Vite dev server; expects the API on http://localhost:3000)
npm --prefix frontend run dev     # → http://localhost:5173

# Or use the packaged nginx build from the Docker stack
```

The UI has a **Demo scenario** select that pre-fills a reserved `EMP-DEMO-*` employee id to
deterministically force each lifecycle outcome server-side — great for a reviewer:

| Scenario | Employee id | What you'll see |
|---|---|---|
| Success (default) | `EMP-DEMO-SUCCESS` | `received → success`, one `SUCCESS` attempt at 1 |
| Retry, then recover | `EMP-DEMO-RECOVER` | transient at 1–2 (list stays `queued`), `FAILED`/`TEMPORARY` rows at 1–2, `SUCCESS` at attempt 3 |
| Retry, then exhausted | `EMP-DEMO-TRANSIENT` | ~20 s of retries (backoff 1 s→2 s→4 s→8 s), one `FAILED` / `TEMPORARY` row per attempt, then the event ends `failed` |
| Retry, then fail | `EMP-DEMO-FAILAFTER` | transient at 1–2 (backoff 1 s→2 s), then a permanent rejection at attempt 3 — `FAILED` / `TEMPORARY` rows at 1–2, `FAILED` / `PERMANENT` at 3 |
| Permanent failure | `EMP-DEMO-PERMANENT` | `FAILED` / `PERMANENT` at attempt 1, no retry |

Scenarios work from *any* submitter (UI, Swagger, curl) and win over `PAYROLL_FAILURE_MODE`.
Details: `src/processing/demo-scenarios.ts` and `frontend/README.md`.

---

## Running tests

| Suite | Command | What it covers |
|---|---|---|
| Backend unit (Jest) | `npm test` | DTO validation, idempotency service, queue producer, provider failure logic, the transactional claim, handlers, health. |
| E2E (Jest + supertest, real Postgres + Redis) | `npm run test:e2e` | Full flows: submit → idempotent replay, queue, processing, retry/exhaustion, crash recovery, `/health`, status API. |
| Frontend (Vitest) | `npm --prefix frontend run test:run` | Submit-form behavior, scenario mapping, event-type contract. |

**E2E prerequisites:** Postgres + Redis must be reachable at the `.env.test` values
(`localhost:5432` / `localhost:6379`) and migrations applied (`npx prisma migrate deploy`).
The e2e suite boots the API **and an in-process worker** (ts-jest), so:

```bash
# If you started the Docker stack, STOP the dockerized worker first — a second
# consumer races the in-process one and can time out the failure-lifecycle tests:
docker compose stop worker
npm run test:e2e
```

The CI pipeline runs all three suites per commit (backend + frontend + e2e against real
service containers, no worker container — so no race). See `.github/workflows/ci.yml`.

---

## Database design

All tables in `prisma/schema.prisma`, migrations in `prisma/migrations/`.

**`payroll_events`** — one row per submitted event: `event_type`, `employee_id`, validated
`payload` (JSONB), `sequence` (monotonic per employee, `UNIQUE (employee_id, sequence)`),
`status` (`received | queued | processing | success | failed`), `processed_at` and `result`
(set only on success), `idempotency_key` (non-unique — traceability only; see D1).

**`idempotency_records`** — the shared store-and-replay dedup layer: one row per `(scope,
key)` carrying the stored HTTP `response_status` + `response_body` and an `expires_at` TTL.
`UNIQUE (scope, key)` is the dedup arbiter; an expiry sweep (`deleteMany(expires_at < now)`)
releases keys for reuse.

**`event_attempts`** — append-only audit trail of **every** attempt that ran, at most one row
per attempt number per event (`UNIQUE (event_id, attempt_number)`). A transient failure
appends a `FAILED(TEMPORARY)` row right after the claim transaction aborts (a row inside it
would roll back with the claim); the terminal `SUCCESS` / `FAILED(PERMANENT)` row commits in
the **same transaction** as the `payroll_events` status change; on retry exhaustion the final
attempt's row is upserted atomically with `queued → failed`.

**`worker_heartbeats`** — worker liveness for `/health`: `worker_id` (PK), `hostname`,
`started_at`, `last_seen_at`, upserted every `WORKER_HEARTBEAT_INTERVAL_MS`.

---

## Background processing design

BullMQ drives the pipeline; Postgres is the source of truth. Mechanics and the reasons for
each are in `docs/architecture.md`; the shape:

1. **Per-employee FIFO** — jobs are added with `jobId = employeeId`, so BullMQ keeps exactly
   one job per employee in flight (parallelism *across* employees, ordering *within*). An
   `add` that is suppressed by an in-flight job is not a lost event: the worker's *relay*
   (`completed` event → find the next pending row for that employee → enqueue it) recovers
   it, driven by Postgres state.
2. **Transactional claim** — `process()` runs one interactive Prisma transaction: `SELECT …
   FOR UPDATE` on the event row, a guarded `UPDATE … SET status='processing' WHERE status='queued'`
   (0 rows → stale/duplicate, skip), payload read, handler dispatch, then the terminal
   transition + `event_attempts` row committed together. A transient handler failure
   re-throws inside the transaction, so it **aborts** and the claim rolls back to `queued` —
   the rollback IS the reset, no explicit write. A crash anywhere before commit leaves the
   row claimable, so multi-worker concurrency and crash recovery share one mechanism.
3. **Retries** — transient failures re-throw and BullMQ schedules the next attempt with
   exponential backoff; permanent failures commit `failed` with `error_type=PERMANENT` and are
   never retried; retry exhaustion writes `queued → failed` + a `FAILED(TEMPORARY)` row.
4. **Stalled-job recovery** — a worker that dies mid-job is detected by BullMQ
   (`lockDuration` 30 s > the 10 s transaction timeout, `stalledInterval` 30 s,
   `maxStalledCount` 1) and its job re-queued; the guarded claim makes reprocessing safe.
5. **Liveness** — each worker upserts a heartbeat row; `/health` reports `degraded` when any
   heartbeat is older than `HEALTH_WORKER_STALE_MS` or BullMQ reports stalled jobs.

---

## Engineering decisions & trade-offs

Highlights; the full decision log (⚠️ forward references resolved) is in
`docs/architecture.md` §10.

1. **Async-first API.** Submission is validate → persist → enqueue → `201`; the client never
   waits on provider work. Trade-off: clients need a way to observe the outcome — hence the
   status API + polling demo UI instead of a synchronous response.
2. **Idempotency stored in Postgres, not Redis.** A dedicated `idempotency_records` table
   with `UNIQUE (scope, key)` is the dedup arbiter; TTL + sweep allow key reuse. Trade-off:
   a DB round-trip instead of a cache read — but correctness never depends on a TTL'd cache's
   eviction/coherence behavior, and the response is stored verbatim for replay.
3. **Exactly-once processing via one transaction.** Row lock → guarded claim → terminal
   write + audit row all commit together. Trade-off: the `FOR UPDATE` lock serializes the two
   contenders for the same event (the loser blocks, then its guarded claim matches 0 rows and
   skips) — a deliberate choice of correctness over opportunistic parallelism, keeping the
   transaction short and well under the BullMQ lock duration.
4. **No explicit `processing → queued` reset.** The abort-on-transient-failure rollback is
   the reset, which also covers crashes — the event can never be stuck in `processing`. The
   status endpoint consequently never serves a `processing` row that went away.
5. **One audit row per attempt.** `event_attempts` records every attempt that ran — the
   transient retries get a `FAILED(TEMPORARY)` row outside the aborted claim, and the
   terminal `SUCCESS` / `FAILED(PERMANENT)` row commits atomically with the terminal
   transition — so the UI shows the full retry cycle before the terminal outcome. The
   `UNIQUE (event_id, attempt_number)` constraint keeps the trail one row per attempt.
6. **Postgres-driven relay.** Enqueue-from-DB on the `completed` event (not at the end of
   `process()`) closes the gap where a producer `add` is suppressed by the in-flight job —
   ordering is guaranteed by the `sequence` column, not by queue metadata alone.
7. **Worker liveness explicitly modeled.** A heartbeat table + `/health` deep check rather
   than assuming BullMQ health; the API can tell you a worker is *gone*, not just that jobs
   stalled.
8. **Deterministic failure lever.** `PAYROLL_FAILURE_MODE` for tests and `EMP-DEMO-*` ids for
   reviewer demos force every lifecycle outcome on demand — no luck-based demos.
9. **Two Node versions, deliberately.** Backend and e2e pin Node 20 to match the
   `node:20-alpine` Docker images; the frontend job uses Node 22 because its jsdom-based
   Vitest suite cannot boot on Node 20 (undici `webidl` API absent) and Vite 8 / TS 6 target
   modern Node.
10. **Config frozen at import.** BullMQ worker options and log levels are resolved when the
    module graph loads (Nest `ConfigModule` freezes `process.env` there), so env-driven
    values are read eagerly, never lazily. Documented in the code so a future change doesn't
    silently read stale values.

---

## API documentation (Swagger/OpenAPI)

The API is self-documenting via `@nestjs/swagger`, generated from code annotations (no
hand-maintained spec), available in every environment:

- Swagger UI: http://localhost:3000/api-docs
- Raw OpenAPI JSON: http://localhost:3000/api-docs-json

---

## Project structure

```
.
├── src/                     # NestJS API application (shared by the worker)
│   ├── events/              # POST /events + GET /events/:id — DTOs, validation, service
│   ├── processing/          # Handler registry, simulated provider, demo scenarios,
│   │                        #   transactional event-claim, worker heartbeat service
│   ├── queue/               # BullMQ producer + worker processor, per-employee FIFO,
│   │                        #   worker options, relay
│   ├── common/              # Idempotency layer, health controller, global filter, logger
│   └── prisma/              # PrismaService
├── apps/
│   └── worker/              # Standalone BullMQ worker entrypoint
├── prisma/                  # schema.prisma + migrations
├── frontend/                # React + Vite demo UI (submit / list / detail)
├── docker/                  # Multi-stage Dockerfiles + entrypoint
├── test/                    # e2e / integration tests (jest-e2e)
├── docs/                    # architecture.md — full design narrative
├── .github/workflows/       # CI pipeline (backend + frontend + e2e)
└── docker-compose.yml       # API + worker + Postgres + Redis + frontend
```

---

## License

Private — assignment submission.