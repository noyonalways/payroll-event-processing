# Payroll Event Processing Service

Backend Engineering Technical Assignment — a production-oriented, reliable **asynchronous payroll event processing service**.

Built with **NestJS + TypeScript + PostgreSQL + Redis + BullMQ + Docker + GitHub Actions**.

[![CI](https://github.com/noyonalways/payroll-event-processing/actions/workflows/ci.yml/badge.svg)](https://github.com/noyonalways/payroll-event-processing/actions/workflows/ci.yml)

> **Status:** Implemented. The full stack (API + worker + Postgres + Redis + demo UI) runs
> together, the reliability layer is in place, and a three-job CI pipeline gates `main`.
> **Multi-tenancy and authentication are implemented** (archived as
> `openspec/specs/authentication` + `openspec/specs/tenancy`): every route requires a bearer
> token except the health check and the auth entry points, and all payroll data is scoped to an
> organization. The repository is a **pnpm + Turborepo workspace** — three apps, five packages
> (see [Project structure](#project-structure)). The `docs/architecture.md` file has the complete
> design narrative with every reliability requirement mapped to its enforcement point.

---

## Table of contents

- [What it does](#what-it-does)
- [Tenancy and authentication](#tenancy-and-authentication)
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

Event submission → authenticate → validate → idempotency check → persist → enqueue → fast `201` response.
A separate worker picks events off a queue, runs a *simulated* external payroll operation
(which occasionally fails), and records the outcome. Clients track progress through
read-only endpoints — `GET /events` (the paginated, filterable history) and
`GET /events/{id}` (full status + attempt trail) — or the demo UI, which pages the former
and polls the latter.

Every request is authenticated, and every row of payroll data belongs to one organization: the
caller's organization comes from a signed access token, never from the request. See
[Tenancy and authentication](#tenancy-and-authentication).

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

Event lifecycle: `received → queued → processing → success | failed`, plus `cancelled` — a manual terminal state reachable only from the pending states through the recovery actions (with a per-attempt audit trail and an append-only action audit).

### API surface

| Endpoint | Auth | Description |
|---|---|---|
| `POST /auth/register` | public | Create a new organization with the caller as its `OWNER`; returns a session (`201`). `409` if the email already has an account, `400` for a password shorter than 12 characters. |
| `POST /auth/login` | public | Exchange credentials for a session bound to one organization. `401` for a wrong password or an unknown email (identical responses); `400` if the account belongs to several organizations and `organizationId` is omitted. |
| `POST /auth/refresh` | public | Rotate a refresh token into a new access/refresh pair. The presented token is single-use — replaying a consumed one revokes every live refresh token for that user (`401`). |
| `POST /auth/logout` | public | Revoke the presented refresh token. Always `204`, even for an unknown or already-revoked token. |
| `GET /auth/me` | `Authorization: Bearer <accessToken>` | The authenticated user, the organization their token is scoped to, and their role there. |
| `POST /events` | `Authorization: Bearer <accessToken>` | Submit an event. Also requires the `Idempotency-Key` header. Returns `201` with the stored response (duplicates replay it). |
| `GET /events` | `Authorization: Bearer <accessToken>` | Read-only paginated event history: one page of the organization's events, newest first (`created_at DESC, id DESC`) as `{ data, nextCursor, limit }`. Combinable filters — `status`, `eventType`, `employeeId`, `createdAfter`/`createdBefore` (inclusive) — AND together and compose with the keyset cursor: pass a page's `nextCursor` back as `cursor` to keep walking without page shifts. Rows carry no payload, result, or attempts (that is `GET /events/:id`). `400` for invalid filter values, an out-of-range `limit` (1–100), or an unparsable cursor. |
| `GET /events/:id` | `Authorization: Bearer <accessToken>` | Read-only event status: committed lifecycle state, details, and the attempt history (one row per attempt). `404` for unknown ids **and for an event belonging to another organization** — the two are indistinguishable. |
| `POST /events/:id/retry` | `Authorization: Bearer <accessToken>` | Manual recovery: move a terminal `failed` event back to `queued` and schedule it again on its employee's chain. Attempt numbering is continuous across retry rounds (the trail keeps one row per attempt). `409` for any other lifecycle state, `404` for unknown/foreign ids. The action is effective even when Redis is unreachable (the relay schedules it later). |
| `POST /events/:id/cancel` | `Authorization: Bearer <accessToken>` | Manual recovery: cancel a pending (`received`/`queued`) event. `cancelled` is terminal — a job that later surfaces for it is a no-op, and the employee's chain keeps draining behind it. `409` for any other state, `404` for unknown/foreign ids. |
| `GET /health` | public | Service health: DB + Redis reachability, worker liveness heartbeats, BullMQ stalled-job count. Always `200`; the body carries `status: ok \| degraded`. |
| `GET /api-docs` | public | Swagger UI (interactive). Raw spec at `/api-docs-json`. |

A protected route without a valid, unexpired access token returns `401`; the same applies to a
token that is malformed, tampered, expired, foreign-signed, or a refresh token presented as an
access token. The public routes are exactly `GET /health`, the four `/auth/*` entry points above,
and the API docs.

---

## Tenancy and authentication

An **organization** is the boundary for all payroll data. Every tenant-owned row records its
organization, every read and write is filtered by the organization of the caller's session, and
no endpoint operates across organizations. The organization comes from the signed access token —
a request body field, query parameter, or header cannot steer it.

**Identity and sessions**

- `POST /auth/register` creates a **new** organization, the user account, and an `OWNER`
  membership in one transaction; the registrant is that owner. There is no self-service way into
  an existing organization — invitations are a later change.
- **Access tokens** are short-lived signed JWTs (`AUTH_ACCESS_TOKEN_TTL`, default `15m`) carrying
  the user, the organization, and the role. Verification is stateless, so the guard costs no
  database round-trip.
- **Refresh tokens** are opaque random values, stored only as a SHA-256 digest
  (`refresh_tokens`), and single-use: `POST /auth/refresh` consumes the presented token and
  returns a new pair. Replaying a consumed token is treated as reuse and revokes every live
  refresh token for that user. A session is bound to **one** organization, so a refresh cannot
  move it.
- **Deny-by-default guard**: a global guard authenticates every route. Only `GET /health`, the
  `/auth/*` entry points (register, login, refresh, logout), and the API docs are public. A
  protected route without a valid `Authorization: Bearer <accessToken>` gets `401`.
- **Cross-organization access is a `404`**, exactly like an unknown id: a `403` would confirm the
  identifier exists elsewhere. Login follows the same rule — a wrong password, an unknown email,
  and an organization the account does not belong to all produce the same `401`.

**Tenant-local identifiers**

- `employeeId` stays a string supplied in the payload, now interpreted **within the caller's
  organization**: two organizations may use the same employee number, each starting its own
  `sequence` and its own per-employee queue slot.
- `Idempotency-Key` deduplicates **within the caller's organization**
  (`UNIQUE (organization_id, scope, key)`). A client-chosen key is only unique per tenant; were
  it global, two organizations picking the same value would collide and the second would be
  served the first one's stored response body.

The design rationale, alternatives considered, and the migration/rollback plan are in
`openspec/changes/multi-tenant-foundation/design.md`; `docs/architecture.md` carries the
enforcement mapping (§5 R8) and the decision log (§10 D6–D11).

### Example: register, then submit

```bash
# 1. Register — creates the organization and its OWNER, and returns a session.
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.example","password":"correct-horse-battery","organizationName":"Acme Payroll"}'
# → { "user": { … }, "organization": { … }, "role": "OWNER",
#     "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer", … }

# 2. Submit an event in that organization — copy the accessToken from step 1.
curl -s -X POST http://localhost:3000/events \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: smoke-1' \
  -d '{"eventType":"BANK_ACCOUNT_CHANGE","payload":{"employeeId":"EMP-001","effectiveDate":"2026-09-01","iban":"DE89370400440532013000"}}'

# 3. Read it back — only a session in the owning organization can.
curl -s http://localhost:3000/events/<id> -H 'Authorization: Bearer <accessToken>'
```

---

## Quick start (Docker)

Requires Docker + Docker Compose.

```bash
# The api/worker services read apps/api/.env.development as their env_file, and
# it is gitignored — create it from the template before the first run. The
# template lives at the workspace root; the real stage files live with the API
# app.
cp apps/api/.env.example apps/api/.env.development
#   PowerShell: Copy-Item apps/api/.env.example apps/api/.env.development

docker compose up --build
```

> **Before the first boot:** `.env.example` ships a placeholder `AUTH_JWT_SECRET`. The
> application validates it at startup (minimum 32 characters, no default) and **refuses to boot**
> without a valid value, so a deployment can never sign tokens with an empty or guessable key.
> Generate one per stage with `openssl rand -base64 48` and paste it into `apps/api/.env.development`.

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

Send a first event to see the pipeline move end-to-end. Submissions are organization-scoped and
require an access token, so register first (this creates a throwaway organization in the stack's
database) and copy the `accessToken` from the response:

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.example","password":"correct-horse-battery","organizationName":"Acme Payroll"}'

curl -s -X POST http://localhost:3000/events \
  -H 'Authorization: Bearer <accessToken from the register response>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: smoke-1' \
  -d '{"eventType":"BANK_ACCOUNT_CHANGE","payload":{"employeeId":"EMP-001","effectiveDate":"2026-09-01","iban":"DE89370400440532013000"}}'
```

The full walkthrough, including reading the event back with the same token, is in
[Tenancy and authentication](#tenancy-and-authentication).

Tear everything down with `docker compose down` (add `-v` to also drop the `pgdata` volume).

---

## Architecture

```
                ┌──────────────────────────────────────────────┐
                │  Client: demo UI (:5173) · curl · Swagger     │
                └──────────────────────┬───────────────────────┘
                                       │ POST /auth/* (session)
                                       │ POST /events (Bearer + Idempotency-Key)
                                       │ GET /events (Bearer, paginated history)
                                       │ GET /events/:id · GET /health
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  NestJS API  (:3000)                          │
                │  JwtAuthGuard (deny-by-default) → actor.org   │
                │  validate → idempotency → persist → enqueue   │
                │  every tenant-scoped query filters by org     │
                └───────┬──────────────────────────────┬────────┘
                 Prisma │ (DB is the source of truth)  │ BullMQ add
                        │                              │ jobId = org|employee
                        ▼                              ▼
         ┌──────────────────────────┐      ┌───────────────────────────┐
         │  PostgreSQL 16           │      │  Redis 7                  │
         │  organizations · users   │◄─────│  payroll-events queue     │
         │  memberships · tokens    │ claim│  (FIFO per employee,      │
         │  payroll_events          │      │   retries with backoff)   │
         │  event_attempts          │      └────────────┬──────────────┘
         │  idempotency_records     │                   │ consumer
         │  worker_heartbeats       │                   │
         └───────────▲──────────────┘                   ▼
                     │ transactional
                     │ claim + terminal write   ┌───────────────────────────────┐
                     └───────────────────────── │  BullMQ Worker  (apps/worker) │
                                               │  claim (SELECT … FOR UPDATE,   │
                                               │  scoped by (id, organization)) │
                                               │  handler → simulated provider  │
                                               │  retry/backoff · relay · beats │
                                               └───────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| **HTTP API app** (`apps/api/`) | Entrypoint (`main.ts`) bootstrapping the composition root from `@repo/core`: global deny-by-default `JwtAuthGuard`; DTO validation (class-validator), per-type payload rules, the shared idempotency layer, persist + enqueue, read-only status, `/health`. |
| **Auth & tenancy** (`packages/core/src/auth/`) | Registration/login/refresh/logout, scrypt password hashing, and the guard that resolves the caller's organization from the signed access token; tenant-scoped queries take that organization as a required argument. |
| **Redis / BullMQ** | `payroll-events` job queue. The tenant-qualified `jobId = <organizationId>\|<employeeId>` makes it FIFO per employee *within an organization* while other employees run in parallel. Delayed jobs implement backoff; stalled-job detection recovers crashed workers. |
| **Worker app** (`apps/worker/`) | Consumer entrypoint bootstrapping the worker composition root from `@repo/core`: claims a job, takes the DB row lock inside a single transaction, dispatches to the per-type handler, and commits the terminal state + audit row atomically — every statement scoped by the job's organization. |
| **PostgreSQL / Prisma** (`packages/database/`) | Ground truth for identity, event state, idempotency, attempt history, and worker liveness. Unique constraints + the row lock make the guarantees hold even with multiple workers; tenant-qualified unique keys keep two organizations' data independent. |
| **Simulated provider** (`packages/core/src/processing/`) | Fake external payroll call with env-tunable transient/permanent failure rates; deterministic `EMP-DEMO-*` scenarios for review demos. |
| **Demo UI** (`apps/web/`) | React + Vite two-pane app: sign in (or register an organization), submit an event, browse the organization's server-driven history (`GET /events`: filters, load-more paging) with live status polling on in-flight rows, inspect detail + failure trail. Imports the event-type contract and the error-body shape from `@repo/shared`. |

Interactive diagrams (ERD, event flow, lifecycle state machine, system architecture) are
hosted on **Eraser**: <https://app.eraser.io/workspace/hIaUa8ZhdcDwT5YtdUiI>. Visual-only —
the prose below and **`docs/architecture.md`** stay the source of truth.

The full design narrative — the seven reliability requirements plus the tenancy boundary mapped
to enforcement points, sequence flows, and every decision record — lives in
**`docs/architecture.md`**.

---

## Installation (running on the host)

Recommended for development and for running tests. The database and Redis below are the only
infrastructure needed; everything else runs as Node processes.

**Prerequisites**

- Node.js ≥ 20 (the backend resolves all engines on 20; Node 22 is needed for the web app's
  Vitest suite — see the CI note). A current LTS installs both via `npx` if you prefer.
- pnpm 12 (`packageManager` in the root `package.json` pins the exact version: `corepack enable`
  is enough; pnpm is read from `packageManager` on every run)
- Docker (optional — only for Postgres/Redis containers or the full compose stack)

**Steps**

```bash
# 1. Install every workspace member's dependencies (frozen lockfile)
pnpm install --frozen-lockfile

# 2. Generate the Prisma client (needed before the app or tests can run)
pnpm --filter @repo/database exec prisma generate

# 3. Create your local env files — the stage files live with the API app and
#    are gitignored; the template ships at the workspace root. Copy it for the
#    stages you plan to run. The template's AUTH_JWT_SECRET is a placeholder:
#    replace it per stage with `openssl rand -base64 48` — the app refuses to
#    boot when the value is missing or shorter than 32 characters.
cp apps/api/.env.example apps/api/.env.development
cp apps/api/.env.example apps/api/.env.test
#   PowerShell: Copy-Item apps/api/.env.example apps/api/.env.development

# 4. The Prisma CLI reads packages/database/.env. Create it with a DATABASE_URL
#    and keep it in sync with apps/api/.env.development (gitignored — see
#    "The stage-file story" below).
cp apps/api/.env.development packages/database/.env
#   PowerShell: Copy-Item apps/api/.env.development packages/database/.env
```

Now bring up the infrastructure. If you have Docker:

```bash
docker compose up -d postgres redis
```

Or run Postgres/Redis however you prefer (a local install, Homebrew, etc.) and keep the
`localhost` values in `apps/api/.env.development`.

---

## Environment variables

The app is configured entirely through environment variables. Both backend apps resolve
**`apps/api/.env.<NODE_ENV>`** to an absolute path (`.env.development`, `.env.test`, …);
`NODE_ENV` selects the file, and the resolution is independent of the directory the app is
launched from (workspace root, the app's own directory, or through turbo — the resolver in
`@repo/core` walks up to the workspace marker). A missing stage file fails startup loudly,
**naming the file**, unless the required variables were injected another way — the container
path, where `docker-compose.yml` provides them as real environment variables and overrides the
two topology vars (`DATABASE_URL`, `REDIS_HOST`) with compose-network service names.

**.env template:** `apps/api/.env.example` — copy it to
`apps/api/.env.development` / `apps/api/.env.test` and adjust.

**The stage-file story:** the template (`apps/api/.env.example`) lives beside the stage files it templates;
the real stage files live with the API app (`apps/api/.env.<NODE_ENV>`) because that is
the app a developer runs on the host, and both entrypoints read that one set. The **Prisma
CLI** (`migrate`, `studio`) auto-loads a plain `.env` beside the schema — so
`packages/database/.env` exists solely so Prisma commands work without exporting variables by
hand; keep its `DATABASE_URL` in sync with the stage file. (One mechanism to know: the
generated Prisma client preloads that schema-adjacent file into `process.env` at import, and
`process.env` outranks the stage file — so `packages/database/.env` must carry the default
host URL, and a run that needs a different database overrides it through the environment.)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Picks the `apps/api/.env.<NODE_ENV>` stage file. |
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
| `AUTH_JWT_SECRET` | *(none — **required**, min 32 chars)* | HMAC-SHA256 key signing access tokens. Validated at boot: the app **fails fast** when it is missing or shorter than 32 characters, so it can never run with an empty or guessable signing key. Generate with `openssl rand -base64 48`. |
| `AUTH_ACCESS_TOKEN_TTL` | `15m` | Access-token lifetime. Access tokens are stateless, so expiry is the only revocation that applies to them — keep it short. |
| `AUTH_REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh-token lifetime in days. Refresh tokens are revocable (hashed rows that rotation consumes), so this can be long-lived. |

---

## Database setup & migrations

All schema changes live in `packages/database/prisma/migrations/` and are applied with Prisma
Migrate. Eight tables: `payroll_events`, `idempotency_records`, `event_attempts`,
`worker_heartbeats`, plus the tenancy/identity tables `organizations`, `users`, `memberships`,
and `refresh_tokens` (see [Database design](#database-design)).

```bash
# Apply all pending migrations (idempotent; safe on any environment, incl. CI)
pnpm --filter @repo/database exec prisma migrate deploy

# During development, create the next migration from a schema.prisma edit
pnpm --filter @repo/database exec prisma migrate dev --name describe_the_change

# Inspect data / schema interactively
pnpm --filter @repo/database exec prisma studio
```

- **Local / CI:** `migrate deploy` applies the committed migrations in order — it never
  generates new ones and never needs a shadow database.
- **Docker stack:** the API entrypoint runs `migrate deploy` automatically on first start,
  pointed at the schema inside `@repo/database`.
- **Prisma CLI access:** the CLI reads `packages/database/.env` (see the stage-file story
  above). For a non-local stage, pass the URL inline instead:
  `$env:DATABASE_URL = '<url>'; pnpm --filter @repo/database exec prisma migrate status`.

**Multi-tenant backfill.** The `multi_tenant_foundation` migration adds a `NOT NULL`
`organization_id` (FK, **no default** — tenancy can never be implicit) to `payroll_events` and
`idempotency_records`. Pre-existing rows are adopted by a single deterministic organization — id
`00000000-0000-0000-0000-000000000001`, name `Legacy Tenant`, slug `legacy` — which is created
**only when there is pre-existing data to adopt**, so a fresh database never gets a phantom
organization. The legacy tenant has **no members**: nobody can sign in as it, so its rows must be
reassigned to a real organization (or administered directly in the database) as a deliberate
operational step. The migration also replaces the global unique keys and single-column indexes
with tenant-qualified ones and adds the `event_attempts` → `payroll_events` foreign key.

---

## Starting the API

```bash
# Development (watch mode) — needs apps/api/.env.development + Postgres + Redis up
pnpm dev:api

# Production-style: build then run the compiled output
pnpm build
pnpm --filter @repo/api start
```

Confirm it is up: http://localhost:3000/health (should report `status: "ok"` once a worker is
running too), Swagger at http://localhost:3000/api-docs. Either invocation directory works —
from the workspace root (`pnpm dev:api`) or from inside `apps/api` (`pnpm dev`) — both resolve
the same `apps/api/.env.development`.

Submit one of the sample payloads under **Demo scenarios** in the UI, or follow the
register → submit curl flow in [Tenancy and authentication](#tenancy-and-authentication) — both
the `Idempotency-Key` header and a bearer token are required.

---

## Starting the worker

The API only enqueues jobs — a worker process must consume them for events to progress past
`queued`.

```bash
# Development (watch mode)
pnpm dev:worker

# Production-style
pnpm build
pnpm --filter @repo/worker exec node dist/main.js
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
pnpm dev:web                      # → http://localhost:5173

# Or use the packaged nginx build from the Docker stack
```

The UI now starts at a **sign-in / register** step: `POST /events` requires an access token, so
no submission is possible without a session. Registering creates a new organization with you as
its `OWNER`; signing in returns the session for an organization you already belong to. The
session is kept in `localStorage` (it survives a page reload), every request carries the access
token, and a `401` triggers **one transparent refresh** with the stored refresh token before the
request is replayed — if the refresh fails, the session is discarded and the UI returns to
sign-in. The header shows the organization and role the session is acting in plus the
signed-in email, and its **Sign out** button revokes the refresh token via `POST /auth/logout`
before clearing local state — the history itself is server-owned, so a different organization
signing in next simply fetches its own.

The events view is **server-driven**: the list is the organization's history from `GET /events`
(paginated, newest first) with combinable filters — lifecycle status, event type, employee id,
and created-date bounds — and a **Load more** action following the cursor. Submitting an event
re-fetches page one, so it appears without a reload; nothing is persisted in the browser, so a
reload just re-fetches and a sign-out leaves nothing behind. Rows whose status is not terminal
keep live-polling `GET /events/{id}` for badge and attempt-count updates.

The UI has a **Demo scenario** select that pre-fills a reserved `EMP-DEMO-*` employee id to
deterministically force each lifecycle outcome server-side — great for a reviewer:

| Scenario | Employee id | What you'll see |
|---|---|---|
| Success (default) | `EMP-DEMO-SUCCESS` | `received → success`, one `SUCCESS` attempt at 1 |
| Retry, then recover | `EMP-DEMO-RECOVER` | transient at 1–2 (list stays `queued`), `FAILED`/`TEMPORARY` rows at 1–2, `SUCCESS` at attempt 3 |
| Retry, then exhausted | `EMP-DEMO-TRANSIENT` | ~20 s of retries (backoff 1 s→2 s→4 s→8 s), one `FAILED` / `TEMPORARY` row per attempt, then the event ends `failed` |
| Retry, then fail | `EMP-DEMO-FAILAFTER` | transient at 1–2 (backoff 1 s→2 s), then a permanent rejection at attempt 3 — `FAILED` / `TEMPORARY` rows at 1–2, `FAILED` / `PERMANENT` at 3 |
| Permanent failure | `EMP-DEMO-PERMANENT` | `FAILED` / `PERMANENT` at attempt 1, no retry |

Scenarios work from *any* authenticated submitter (the UI, curl, or any client sending a bearer
token) and win over `PAYROLL_FAILURE_MODE`.
Details: `packages/shared/src/demo-scenarios.ts` (the mapping) and `apps/web/README.md`.

---

## Running tests

| Suite | Command | Size | What it covers |
|---|---|---|---|
| Backend unit (Jest) | `pnpm test` | 233 tests, 21 suites | DTO validation (including the list query parameters), auth services + guard, idempotency service, queue producer, provider failure logic, the transactional claim, handlers, health, and the events service reads (status + the tenant-scoped, cursor-paginated history query). |
| E2E (Jest + supertest, real Postgres + Redis) | `pnpm test:e2e` | 83 tests, 11 suites | Full flows: register → submit → idempotent replay, queue, processing, retry/exhaustion, crash recovery, `/health`, status API, the event-history API (pagination walk, filter composition, cross-tenant blindness, pagination stability, malformed cursor/limit), and cross-organization isolation (`apps/api/test/tenant-isolation.e2e-spec.ts`). |
| Frontend (Vitest) | `pnpm --filter @repo/web test:run` | 84 tests | Sign-in/registration, session persistence, submit-form behavior, scenario mapping, event-type contract, and the server-driven history hook (filter re-fetches, load-more cursor walks, row polling). |

All three run from the workspace root as `turbo run` wrappers — `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm test:e2e` — dependency-ordered and cached (except `test:e2e`,
which drives real services and is never cached).

**E2E prerequisites:** Postgres + Redis must be reachable at the `apps/api/.env.test` values
(`localhost:5432` / `localhost:6379`), migrations applied (`pnpm --filter @repo/database exec
prisma migrate deploy`), and `AUTH_JWT_SECRET` set to at least 32 characters in
`apps/api/.env.test` — the app validates it at boot and **refuses to start without it**, so an
e2e run fails in `beforeAll` otherwise. CI has no stage files and exports the values in the job
environment (`.github/workflows/ci.yml`) — the resolver accepts an injected environment when
the stage file is absent.
The suites that call the API authenticate through the shared helper `apps/api/test/support/auth.ts`
(`registerTenant` registers a fresh organization via the real `POST /auth/register` surface), so
they exercise the same path a client would; the DB-level suites (`health-check`,
`recovery-schema`, `idempotency-records`) hit Prisma directly or use only public endpoints and
need no session.
The e2e suite boots the API **and an in-process worker** (ts-jest), so:

```bash
# If you started the Docker stack, STOP the dockerized worker first — a second
# consumer races the in-process one and can time out the failure-lifecycle tests:
docker compose stop worker
pnpm test:e2e
```

The CI pipeline runs all three suites per commit (backend + frontend + e2e against real
service containers, no worker container — so no race). See `.github/workflows/ci.yml`.

---

## Database design

All tables in `packages/database/prisma/schema.prisma`, migrations in
`packages/database/prisma/migrations/` — the schema, the migration history, and the generated
client belong to `@repo/database` alone.

**`organizations`** — a tenant: `id`, `name`, unique `slug` (derived from the name and
disambiguated on collision, so two companies may share a display name). Every tenant-owned row
points here.

**`users`** — a person, global rather than nested under an organization (one person may belong
to several): unique lowercased `email`, `password_hash` (scrypt digest in the self-describing
`scrypt$N$r$p$salt$hash` form), optional `name`.

**`memberships`** — binds a user to an organization with a role (`OWNER | ADMIN | MEMBER`),
`UNIQUE (user_id, organization_id)`. This row — not the access token alone — is the authority for
whether a user may act in an organization: the refresh path re-reads it, so a removed membership
stops being usable within one access-token lifetime.

**`refresh_tokens`** — one issued refresh token per row: `token_hash` (unique SHA-256 digest —
the token value itself is never stored), `user_id`, `organization_id` (the session's tenant, so a
refresh can only re-issue for the same organization), `expires_at`, `revoked_at`. Rotation
consumes the presented row and issues a new one; a reused (already-revoked) token revokes every
live token for that user.

**`payroll_events`** — one row per submitted event: `organization_id` (FK, `NOT NULL`, **no
default** — the tenant discriminator), `event_type`, `employee_id` (a **tenant-local** string;
two organizations may reuse the same one), validated `payload` (JSONB), `sequence` (monotonic per
employee **within the organization**), `status` (`received | queued | processing | success |
failed`), `processed_at` and `result` (set only on success), `idempotency_key` (non-unique —
traceability only; see D1). Constraints/indexes are tenant-leading:
`UNIQUE (organization_id, employee_id, sequence)`, index on `(organization_id, status)`, index
on `(organization_id, status, created_at DESC, id DESC)` (serves the history pages: the
equality prefix fixes a contiguous index range already in newest-first order, so pages read
exactly the requested rows with no sort), and index on
`(organization_id, employee_id, created_at)`.

**`idempotency_records`** — the shared store-and-replay dedup layer: one row per `(organization,
scope, key)` carrying the stored HTTP `response_status` + `response_body` and an `expires_at`
TTL. `UNIQUE (organization_id, scope, key)` is the dedup arbiter — the organization is part of
the key because client-chosen keys are only unique within a tenant; an expiry sweep
(`deleteMany(expires_at < now)`) releases keys for reuse.

**`event_attempts`** — append-only audit trail of **every** attempt that ran, at most one row
per attempt number per event (`UNIQUE (event_id, attempt_number)`). A transient failure
appends a `FAILED(TEMPORARY)` row right after the claim transaction aborts (a row inside it
would roll back with the claim); the terminal `SUCCESS` / `FAILED(PERMANENT)` row commits in
the **same transaction** as the `payroll_events` status change; on retry exhaustion the final
attempt's row is upserted atomically with `queued → failed`. `event_id` carries a real foreign
key to `payroll_events` (`ON DELETE CASCADE`), so the trail cannot be orphaned and deleting an
organization cleans its attempts up.

**`worker_heartbeats`** — worker liveness for `/health`: `worker_id` (PK), `hostname`,
`started_at`, `last_seen_at`, upserted every `WORKER_HEARTBEAT_INTERVAL_MS`. Deliberately not
tenant-scoped: the worker fleet is shared infrastructure serving every organization.

---

## Background processing design

BullMQ drives the pipeline; Postgres is the source of truth. Mechanics and the reasons for
each are in `docs/architecture.md`; the shape:

1. **Per-employee FIFO** — jobs are added with a **tenant-qualified** `jobId`
   (`encodeURIComponent(organizationId)|encodeURIComponent(employeeId)`, e.g. `org-1|emp-1`), so
   BullMQ keeps exactly one job per employee *within an organization* in flight (parallelism
   *across* employees, ordering *within*). The organization is part of the id because employee
   numbers are tenant-local — a bare `employeeId` would let two tenants share one queue slot and
   one tenant's backlog suppress another's events. The separator is `|`, not `:`, because BullMQ
   rejects a custom id containing a colon unless it splits into exactly three segments. An `add`
   that is suppressed by an in-flight job is not a lost event: the worker's *relay* (`completed`
   event → find the next pending row for that employee **in the same organization** → enqueue it)
   recovers it, driven by Postgres state.
2. **Transactional claim** — `process()` runs one interactive Prisma transaction: `SELECT …
   FOR UPDATE` on the event row, a guarded `UPDATE … SET status='processing' WHERE status='queued'`
   (0 rows → stale/duplicate, skip), payload read, handler dispatch, then the terminal
   transition + `event_attempts` row committed together. Every statement is scoped by the event's
   `(id, organization_id)`, taken from the job data, so a forged or corrupt job naming a valid
   foreign event id can never lock or mutate another tenant's row. A transient handler failure
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
   with `UNIQUE (organization_id, scope, key)` is the dedup arbiter; TTL + sweep allow key reuse.
   Trade-off: a DB round-trip instead of a cache read — but correctness never depends on a TTL'd
   cache's eviction/coherence behavior, the key is scoped to the organization so a client-chosen
   key can never replay another tenant's stored response, and the response is stored verbatim for
   replay.
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
11. **Shared-schema tenancy with an application-enforced boundary.** One database, an
    `organization_id` discriminator on every tenant-owned row, and the organization as a
    required argument of every tenant-scoped method — always read from the verified access
    token, never from the request. Trade-off: isolation is application-layer (no Postgres RLS
    yet), asserted by e2e tests that register a second organization, not by the database. Why
    schema-per-tenant / database-per-tenant / Prisma client extensions / RLS were rejected:
    `docs/architecture.md` §10 D6.
12. **The organization is part of the idempotency key.** `UNIQUE (organization_id, scope, key)`
    and `execute(organizationId, scope, key, op)`. A client-chosen key is only unique per tenant: a
    global key space would let two organizations choose the same value, and the second would be
    served the **first organization's stored response body** — a data leak, not merely a
    duplicate. Making the organization a required first argument means a future endpoint cannot
    adopt the layer and forget the tenant. `docs/architecture.md` §10 D7.
13. **Stateless access tokens, revocable refresh tokens.** Access tokens are short-lived signed
    JWTs carrying `{ sub, org, role }` (no DB read on the request hot path); refresh tokens are
    opaque, stored only as a SHA-256 digest, single-use with rotation, and reuse revokes the whole
    token family. Trade-off: a revoked membership stays usable until the access token expires —
    bounded by the deliberately short TTL and re-checked on every refresh.
    `docs/architecture.md` §10 D8.
14. **scrypt from `node:crypto`, not a native argon2 module.** Both runtime images are
    `node:20-alpine`, where a native password-hashing dependency means either a build toolchain
    in the image or a per-platform prebuilt gamble. scrypt ships in the platform, is
    OWASP-accepted, behaves identically on host and in the container, and its self-describing
    digest (`scrypt$N$r$p$salt$hash`) lets the cost parameters be raised later without
    invalidating stored credentials. `docs/architecture.md` §10 D11.
15. **Cross-organization reads are `404`, not `403`.** A `403` would confirm that a row exists in
    another tenant, letting an authenticated tenant enumerate other tenants' identifiers; `404`
    is indistinguishable from an unknown id. Login follows the same rule — a wrong password, an
    unknown email, and a foreign organization all produce the same `401`.
    `docs/architecture.md` §10 D9.
16. **Tenant-qualified queue job id.** The per-employee FIFO key is
    `<organizationId>|<employeeId>` with both parts percent-encoded. BullMQ **rejects a custom id
    containing `:` unless it splits into exactly three segments** (a legacy repeatable-job
    compatibility check) — an earlier `<organizationId>:<employeeId>` form threw on every
    enqueue, and because enqueue failure is deliberately non-fatal (the row is the source of
    truth), the error was swallowed and events sat in `queued`. The `|` join keeps the id
    colon-free, and percent-encoding makes the mapping injective, so distinct (organization,
    employee) pairs can never collapse onto one id and silently suppress a submission.
    `docs/architecture.md` §10 D10.

---

## API documentation (Swagger/OpenAPI)

The API is self-documenting via `@nestjs/swagger`, generated from code annotations (no
hand-maintained spec), available in every environment:

- Swagger UI: http://localhost:3000/api-docs
- Raw OpenAPI JSON: http://localhost:3000/api-docs-json

The document annotates the protected operations (`POST /events`, `GET /events`,
`GET /events/:id`, `GET /auth/me`) with a `bearer` security requirement and documents their
`401` responses (and the list endpoint's `400`), and it
documents the `/auth/*` request bodies and the session schema. One caveat: the `bearer` scheme
itself is not registered in the document (no `components.securitySchemes` entry in
`setup-swagger.ts`), so Swagger UI shows no **Authorize** prompt — call protected endpoints from
the demo UI or the curl flow in [Tenancy and authentication](#tenancy-and-authentication).

---

## Project structure

A pnpm + Turborepo workspace. Three apps (what ships as a process — each with its own
Dockerfile) and five packages (each answering a different question). `pnpm install` links the
members; `pnpm build` (and every other intent) runs through `turbo run` in dependency order.

```
.
├── apps/
│   ├── api/                 # HTTP entrypoint (main.ts) + the end-to-end suites
│   │   ├── src/main.ts      #   bootstraps AppModule from @repo/core
│   │   ├── test/            #   jest-e2e suites (real Postgres + Redis)
│   │   ├── Dockerfile       #   + docker-entrypoint.sh (migrate deploy → serve)
│   │   └── .env.<NODE_ENV>  #   the stage env files live here (gitignored)
│   ├── worker/              # BullMQ consumer entrypoint (main.ts, WorkerModule)
│   └── web/                 # React + Vite demo UI (was frontend/)
├── packages/
│   ├── core/                # @repo/core — the business logic: domain, processing,
│   │                        #   queue semantics, idempotency, tenancy, auth, and
│   │                        #   BOTH composition roots (AppModule + WorkerModule)
│   ├── database/            # @repo/database — outbound clients: prisma/schema.prisma
│   │                        #   + migrations + generated client, PrismaService,
│   │                        #   Redis/BullMQ connection; owns packages/database/.env
│   ├── shared/              # @repo/shared — the framework-agnostic vocabulary:
│   │                        #   event types, queue/idempotency identifiers,
│   │                        #   result + error shapes, error body, demo scenarios
│   ├── eslint-config/       # @repo/eslint-config — backend flat lint config
│   └── typescript-config/   # @repo/typescript-config — base + Nest/React presets
├── turbo.json               # Task graph: build/lint/typecheck/test cached,
│                            #   dev/test:e2e uncached
├── pnpm-workspace.yaml      # Members: apps/*, packages/*
├── docker-compose.yml       # API + worker + Postgres + Redis + frontend
├── .env.example             # The committed env template (the ONLY env file here)
├── docs/                    # architecture.md — full design narrative
└── .github/workflows/       # CI pipeline (backend + frontend + e2e)
```

**Which package owns what** (the boundary rule: a package may depend on `shared` and
`database`; it may not reach into another package's files; `shared` depends on nothing in the
workspace; no app depends on another app):

- `@repo/core` — what the system **does**. Imports `@repo/database` (outbound clients) and
  `@repo/shared` (vocabulary). Nothing here knows about Express adapters or the DOM.
- `@repo/database` — how the system **reaches its stores** (Prisma + Redis/BullMQ connection).
  Imports `@repo/shared` only.
- `@repo/shared` — what the parts **agree on**. No framework, no database, no queue — verified
  against the browser bundle. Two consumers: `core` and `web`.
- `@repo/eslint-config` / `@repo/typescript-config` — how the code is **checked and compiled**;
  consumed as devDependencies, carry no runtime code.
- `apps/api`, `apps/worker`, `apps/web` — deployable entrypoints; each manifest declares only
  its own runtime dependencies (pnpm enforces it), and the end-to-end suites boot both backend
  composition roots by importing `@repo/core` — no app-to-app dependency.

---

## License

Private — assignment submission.