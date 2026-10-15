# Payroll Event Processing — OpenSpec Change Roadmap

This file tracks all planned OpenSpec changes for the Payroll Event Processing Service.
Work through these **one at a time** using `/opsx:propose` → `/opsx:apply`.

---

## Change Queue

| # | Change Name (kebab-case) | Summary | Status |
|---|---|---|---|
| 1 | `project-scaffold` | NestJS app bootstrap, Docker Compose (Postgres + Redis + API + Worker + Frontend), Prisma setup, health check endpoint, env config, base folder structure | ✅ Done |
| 2 | `event-submission-api` | POST /events endpoint — per-type DTOs & class-validator, global validation pipe, Prisma schema (`payroll_events` table, idempotency key, sequence, status), initial migration, service layer, 201 response. **Event types: `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE` (assignment spec — DTOs/validation/handler registry all use exactly these)** | ✅ Done |
| 3 | `bullmq-queue-integration` | BullMQ module setup, per-employee FIFO (`jobId = employeeId` keeps one job in flight; the `completed`-event relay drains the burst in sequence order), enqueue on event creation (2s best-effort — Redis-down never blocks submission), worker entrypoint in `apps/worker` with guarded `queued→processing→success` transitions and concurrent-safe claim | ✅ Done |
| 4 | `simulated-payroll-processor` | Handler strategy registry (extensible per event type), simulated external call with random transient/permanent failure, success result storage, structured logging (accepted / started / succeeded / failed) | ✅ Done |
| 5 | `retry-and-failure-strategy` | Separate temporary vs permanent failure; BullMQ retry with exponential backoff for transient errors; `failedReason` + attempt log stored on permanent failure; dead-letter behaviour | ✅ Done |
| 6 | `idempotency-layer` | **Required** `Idempotency-Key` header, shared store-and-replay layer (`idempotency_records` table with `UNIQUE (scope, key)` arbiter, TTL + sweep, `P2002` race handling), `POST /events` refactored onto it, dedicated unit + e2e integration tests (`test/idempotency-records.e2e-spec.ts`) | ✅ Done |
| 7 | `concurrency-and-crash-recovery` | Transactional row-locked processing (`SELECT … FOR UPDATE` + guarded `queued→processing` claim in ONE interactive tx that commits terminal `success`/`failed` together with the `event_attempts` audit row); transient failures abort the tx (claim rolls back) — crash at any point leaves the row claimable; `event_attempts`/`worker_heartbeats` tables; BullMQ stalled-job recovery settings (`WORKER_OPTIONS`); worker heartbeats + `/health` liveness (`workers[]`/`stalled`, degraded on stale worker or stalled job) | ✅ Done |
| 8 | `event-status-api` | **GET /events/:id** — read-only status: committed lifecycle state + event details + terminal attempt trail (ascending by `attemptNumber`), 404 `ErrorResponseDto`, `sequence` BigInt→Number — shipped with Swagger docs and e2e (`test/event-status.e2e-spec.ts`). List endpoints (`GET /events`, `GET /events/:id/history`) deliberately deferred — out of assignment scope | ✅ Done |
| 9 | `minimal-frontend` | React + Vite demo UI: typed submit form with demo-scenario selector (`EMP-DEMO-*`), tracked-events list with live-polling status badges (3 s), detail panel with processing result + terminal attempt trail; Vitest + Testing Library coverage | ✅ Done |
| 10 | `test-suite` | 111 backend unit tests + 40 e2e (7 suites: submission, queue, queue-redis-down, processing/retry/exhaustion/recovery, idempotency-records, event-status, api-docs) + 52 frontend Vitest — all gated in CI | ✅ Done |
| 11 | `ci-and-docs` | GitHub Actions CI (backend lint/unit/build · frontend lint/vitest/build · e2e against real Postgres + Redis service containers — all green on `main`), final README, architecture diagram — **Swagger/OpenAPI** (UI at /api-docs, JSON at /api-docs-json) was delivered early by change `swagger-openapi` | ✅ Done |
| 12 | `multi-tenant-foundation` | Multi-tenancy + authentication: `organizations`/`users`/`memberships`/`refresh_tokens`; required tenant discriminator (`organization_id`) on `payroll_events` + `idempotency_records` with tenant-qualified unique keys and tenant-leading indexes; `POST /auth/register\|login\|refresh\|logout` + `GET /auth/me` (short-lived signed access JWTs, single-use rotated hashed refresh tokens, scrypt password digests); deny-by-default guard scoped by the token's organization (cross-org reads are `404`); tenant-qualified queue job ids (`org\|employee`, no colon); backfilling migration with a conditional `Legacy Tenant`; frontend sign-in + transparent refresh | ✅ Done |
| 13 | `turborepo-workspace` | pnpm + Turborepo workspace: three deployable apps (`apps/api`, `apps/worker`, `apps/web` — each with its own Dockerfile built from the workspace root with an app-filtered frozen install) and five packages (`@repo/core` — business logic + both composition roots; `@repo/database` — Prisma schema/client/Redis-BullMQ connection; `@repo/shared` — framework-agnostic vocabulary with two consumers; `@repo/eslint-config`, `@repo/typescript-config`); boundaries enforced by the package manager; stage env files live with the API app behind an explicit resolver; cached turbo tasks; CI on pnpm with per-member scopes | ✅ Done |

---

## Locked-in Decisions (apply to all changes)

| Concern | Choice |
|---|---|
| Framework | **NestJS 11** (v11.2.x, latest stable — Express v5, built-in JSON logger) |
| Testing | **Jest + Supertest + @nestjs/testing** |
| API Documentation | **Swagger / OpenAPI** via `@nestjs/swagger` (Swagger UI: `GET /api-docs`) |
| ORM | **Prisma** (PostgreSQL 16) |
| Queue | **BullMQ** on Redis 7 |
| Logger | NestJS 11 built-in JSON logger (no `nestjs-pino`) |

---

## Notes

- Work through changes **in order** — each builds on the previous.
- After each `/opsx:apply`, mark the row ✅ Done.
- The roadmap may be adjusted if implementation reveals new dependencies.
- Primary evaluation focus: reliability concepts (items 5–7) and test quality (item 10).
- Swagger/OpenAPI (item 11's API-docs portion) was pulled forward and shipped by change `swagger-openapi`; item 11's remaining scope (CI + final README + architecture diagram) is shipped with it now — all 11 planned changes are complete, `multi-tenant-foundation` (item 12) adds authentication and the organization boundary on top, and `turborepo-workspace` (item 13) restructures the repository into a pnpm + Turborepo workspace with no behaviour change.

---

## Reliability Checklist (spans multiple changes)

- [x] Temporary vs permanent failure differentiation
- [x] Idempotency (no duplicate business effects)
- [x] Multiple workers / concurrency safety
- [x] Worker crash recovery (stalled jobs + tx rollback)
- [x] Processing consistency (exactly-once transactional write)
- [x] Per-employee event ordering (parallel across employees)
- [x] Extensible handler/strategy pattern for new event types

---

## Feature Queue (next changes — work top-down, one at a time)

Proposed after the turborepo workspace conversion. Rationale for ordering: 1-4 form the
product spine (browse -> recover -> real employees -> real business effects); 5-6 are the
integration story; 7-9 unlock multi-user completion of the tenancy model; 10-12 are hardening
and housekeeping. Each becomes one OpenSpec change via `/opsx:propose` -> `/opsx:apply`.

| # | Change Name (kebab-case) | Summary | Status |
|---|---|---|---|
| 1 | `events-list-api` | `GET /events` with cursor pagination + filters (status, event type, employee, date range) and a server-driven Events page in the UI; the first way to browse event history | Queued |
| 2 | `event-recovery-actions` | Retry a failed event, cancel a queued one, dead-letter view; manual actions recorded in `event_attempts`/audit | Queued |
| 3 | `employee-directory` | Org-scoped `employees` table + CRUD; `employeeId` validated against it (no more free-form strings) | Queued |
| 4 | `domain-effects` | Handlers write real effective-dated state (compensation, bank account, address, department) inside the claim transaction — events gain a business effect | Queued |
| 5 | `realtime-status` | SSE stream replacing UI polling for lifecycle status | Queued |
| 6 | `integrator-webhooks` | Signed webhooks on terminal states via a transactional outbox (written with the terminal state, per D7's take on the same pattern) | Queued |
| 7 | `role-enforcement` | RBAC guards on endpoints using the existing OWNER/ADMIN/MEMBER roles | Queued |
| 8 | `org-membership-management` | Invitations, member list, role changes (API + UI) — the way a second user joins an organization | Queued |
| 9 | `real-provider-adapter` | Replace the simulated provider behind the handler registry; per-organization external endpoint config | Queued |
| 10 | `observability` | Prometheus/OpenTelemetry metrics, error tracking (Sentry), queue-depth alerting | Queued |
| 11 | `auth-hardening` | Password reset, account lockout, rate limiting (`@nestjs/throttler`), refresh-token retention sweep | Queued |
| 12 | `spec-sync` | Fix two known spec/code drifts: `event-processing` (every processing attempt is now recorded) and pre-monorepo doc remnants | Queued |

Notes:
- 3 should land before 4 (domain effects want a real employee to attach to).
- Deliberately not queued here: TypeScript version unification and remote Turborepo caching — both are
  open questions from the workspace design and start as their own changes after the feature spine.
