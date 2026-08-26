# Payroll Event Processing Service

Backend Engineering Technical Assignment — a production-oriented, reliable **asynchronous payroll event processing service**.

Built with **NestJS + TypeScript + PostgreSQL + Redis + BullMQ + Docker + GitHub Actions**.

[![CI](https://github.com/noyonalways/payroll-event-processing/actions/workflows/ci.yml/badge.svg)](https://github.com/noyonalways/payroll-event-processing/actions/workflows/ci.yml)

> ⚠️ **Status: scaffold / work-in-progress.** This repository currently contains the project skeleton and folder structure. Implementation is coming feature-by-feature via OpenSpec-style small, reviewable changes.

---

## What it does

The service receives employee payroll-related events (bank account change, address change, salary change), persists them, and processes them **asynchronously** in the background so the HTTP request is never blocked by slow processing.

Event submission → validation → persist → enqueue → fast HTTP response.
A separate worker picks events off the queue, runs a *simulated* external payroll operation (which occasionally fails), and records the outcome.

### Supported event types
| Event | Required fields |
|---|---|
| `BANK_ACCOUNT_CHANGE` | `employeeId`, `effectiveDate`, `iban` |
| `ADDRESS_CHANGE` | `employeeId`, `effectiveDate`, `street`, `city`, `postalCode`, `country` |
| `SALARY_CHANGE` | `employeeId`, `effectiveDate`, `newSalary`, `currency` |

---

## Folder structure (planned)

```
.
├── src/                     # NestJS API application (shared with worker)
│   ├── events/              # Event API: controller, DTOs, validation, service
│   ├── processing/          # Simulated payroll processor + handlers
│   ├── queue/               # BullMQ queue setup, processor, per-employee FIFO
│   ├── common/              # Shared pipes, filters, logging, idempotency, locks
│   └── prisma/              # Prisma client
├── apps/
│   └── worker/              # Standalone BullMQ worker entrypoint
├── prisma/                  # Schema + migrations
├── frontend/                # Minimal demo UI (submit / list / detail)
├── docker/                  # Dockerfiles + init
├── .github/workflows/       # CI pipeline
├── test/                    # e2e / integration tests
└── docker-compose.yml       # API + worker + Postgres + Redis + frontend
```

---

## Reliability design overview

This is the core of the assignment. Key concepts to be implemented:

1. **Temporary vs permanent failure** — transient provider errors retry with backoff; permanent (business) errors are marked `failed`, not retried.
2. **Idempotency** — client `Idempotency-Key` / dedupe key + DB unique constraint prevent duplicate business effects.
3. **Concurrency safety** — per-employee FIFO ordering + DB locking (`SELECT ... FOR UPDATE`) across multiple workers.
4. **Crash recovery** — side-effect tracking moves the event to `processing` before work, and BullMQ stalled-job detection re-queues stuck jobs.
5. **Processing consistency** — the success write is transactional and guarded by a status transition so a crash-then-reprocess never applies a change twice.
6. **Event ordering** — a stable `sequence` per employee; FIFO queue group keyed by `employeeId` (parallel across employees).
7. **Extensibility** — a per-event-type handler strategy registry makes new event types drop-in.

Event lifecycle: `received → queued → processing → success | failed` (with attempt/audit history).

*(Detailed architecture diagram and database schema to be added as implementation lands.)*

---

## Getting started

⚠️ Scaffold only — this section will be filled in as the app is built.

```bash
docker compose up --build   # starts Postgres + Redis + API + worker + frontend
```

### API documentation (Swagger/OpenAPI)

The API is self-documenting via Swagger/OpenAPI (`@nestjs/swagger`), available in every environment:

- Swagger UI: http://localhost:3000/api-docs
- Raw OpenAPI JSON: http://localhost:3000/api-docs-json

The OpenAPI document is generated from the code annotations — there is no hand-maintained spec.

### Prisma CLI & Studio

The app loads its config from `.env.<NODE_ENV>` — NestJS `ConfigModule` picks the right file for the running stage automatically — but the **Prisma CLI** (`prisma studio`, `prisma migrate`, `prisma generate`) loads **only a plain `.env`** and has no `--env-file` flag. To make Studio and migrations work without exporting variables by hand, a gitignored `.env` at the repo root holds the dev `DATABASE_URL`; Prisma auto-loads it:

```bash
npx prisma studio
```

> **Why the split?** `.env.*` are gitignored host configs keyed by `NODE_ENV` (see `.env.example`). The `.env` file exists solely so the Prisma CLI can find `DATABASE_URL` — NestJS never reads it. Keep it in sync with `.env.development`.

For a non-dev stage (test/production), inject the URL inline instead:

```powershell
$env:DATABASE_URL = '<url>'; npx prisma migrate status
```

See `docs/` for full setup, env vars, DB migrations, and API docs (Swagger/OpenAPI).

---

## License

Private — assignment submission.
