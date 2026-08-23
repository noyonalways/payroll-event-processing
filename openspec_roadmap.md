# Payroll Event Processing — OpenSpec Change Roadmap

This file tracks all planned OpenSpec changes for the Payroll Event Processing Service.
Work through these **one at a time** using `/opsx:propose` → `/opsx:apply`.

---

## Change Queue

| # | Change Name (kebab-case) | Summary | Status |
|---|---|---|---|
| 1 | `project-scaffold` | NestJS app bootstrap, Docker Compose (Postgres + Redis + API + Worker + Frontend), Prisma setup, health check endpoint, env config, base folder structure | ✅ Done |
| 2 | `event-submission-api` | POST /events endpoint — per-type DTOs & class-validator, global validation pipe, Prisma schema (`payroll_events` table, idempotency key, sequence, status), initial migration, service layer, 201 response. **Event types: `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE` (assignment spec — DTOs/validation/handler registry all use exactly these)** | ⬜ Pending |
| 3 | `bullmq-queue-integration` | BullMQ module setup, per-employee FIFO queue (employeeId as job name / queue key), enqueue on event creation, worker entrypoint in `apps/worker`, basic job logging | ⬜ Pending |
| 4 | `simulated-payroll-processor` | Handler strategy registry (extensible per event type), simulated external call with random transient/permanent failure, success result storage, structured logging (accepted / started / succeeded / failed) | ⬜ Pending |
| 5 | `retry-and-failure-strategy` | Separate temporary vs permanent failure; BullMQ retry with exponential backoff for transient errors; `failedReason` + attempt log stored on permanent failure; dead-letter behaviour | ⬜ Pending |
| 6 | `idempotency-layer` | **Required** `Idempotency-Key` header (NOT NULL + UNIQUE in DB — nullable defeats the dedup guarantee), short-circuit duplicate requests with cached/stored response, integration tests | ⬜ Pending |
| 7 | `concurrency-and-crash-recovery` | Per-employee locking (`SELECT … FOR UPDATE SKIP LOCKED` or advisory lock), status-transition guard (received→queued→processing→success/failed), BullMQ stalled-job detection config, transactional exactly-once write | ⬜ Pending |
| 8 | `event-status-api` | GET /events (list with filters) + GET /events/:id (detail + attempt/audit history), GET /events/:id/history, appropriate 404 handling | ⬜ Pending |
| 9 | `minimal-frontend` | React/Vite (or Next.js) demo UI: submit form, event list with live-polling status badges, event detail drawer/page showing processing result and failure info | ⬜ Pending |
| 10 | `test-suite` | **Jest** + Supertest + @nestjs/testing — unit (mocks), integration (real DB/Redis in Docker), e2e (full HTTP lifecycle via Supertest). Cover all 9 assignment scenarios incl. a worker-recovery test where practical | ⬜ Pending |
| 11 | `ci-and-docs` | GitHub Actions workflow (lint → test → build → docker build), **Swagger/OpenAPI** via @nestjs/swagger (UI at /api-docs, JSON at /api-docs-json), final README, architecture diagram | ⬜ Pending |

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

---

## Reliability Checklist (spans multiple changes)

- [ ] Temporary vs permanent failure differentiation
- [ ] Idempotency (no duplicate business effects)
- [ ] Multiple workers / concurrency safety
- [ ] Worker crash recovery (stalled jobs)
- [ ] Processing consistency (exactly-once transactional write)
- [ ] Per-employee event ordering (parallel across employees)
- [ ] Extensible handler/strategy pattern for new event types
