# Proposal: Event Submission API

## Why

The payroll service currently has no way to accept events — the scaffold has an empty `EventsModule` and no data model. Until a client can submit a `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, or `SALARY_CHANGE` event reliably (validate → dedupe → persist → fast response), the rest of the pipeline (queue, worker, retries) has nothing to process. This change lands the **submission contract**, including the idempotency core (reliability requirement R2), so everything downstream builds on a trusted, deduplicated event store.

## What Changes

- **`POST /events` endpoint** accepting `{ eventType, payload }` for the three supported types:
  - `BANK_ACCOUNT_CHANGE` → `{ employeeId, effectiveDate, iban }`
  - `ADDRESS_CHANGE` → `{ employeeId, effectiveDate, street, city, postalCode, country }`
  - `SALARY_CHANGE` → `{ employeeId, effectiveDate, newSalary, currency }`
- **Per-type DTOs** with `class-validator` decorators, validated by the already-wired global `ValidationPipe` (whitelist + forbidNonWhitelisted → unknown fields rejected).
- **Required `Idempotency-Key` header** — missing key → `400`.
- **Dedupe path** — duplicate key returns the stored response (stored in `response_status`/`response_body`, written in the same insert transaction — decision D2) instead of creating a second event.
- **`payroll_events` table** (Prisma model + initial migration): `id`, `event_type`, `employee_id`, `payload` JSONB, `sequence`, `idempotency_key` (NOT NULL + UNIQUE), `status`, `response_status`, `response_body`, `created_at`, `updated_at`, `processed_at`.
- **Per-employee monotonic `sequence`** computed at insert (reliability R6).
- **Service layer** (`EventsService`) behind the controller; 201 response `{ id, status }`.
- **Enqueue is explicitly out of scope** — this change persists at `status = 'received'` and returns `201 { id, status: 'received' }`; the queue integration (change 3) will transition to `queued` and update the stored response body accordingly.

## Capabilities

### New Capabilities

- `event-submission`: Client submission of typed payroll events — request/response contract, per-type validation, mandatory idempotency with stored-response dedupe, and persistence to `payroll_events` with its uniqueness/ordering invariants.

### Modified Capabilities

<!-- no existing specs change -->

## Impact

- **Code added:** `src/events/events.controller.ts`, `src/events/events.service.ts`, `src/events/dto/` (base event DTO + one DTO per event type), extension of `src/events/events.module.ts`. Shared type/validation config to be reused by the worker later.
- **Schema:** `prisma/schema.prisma` gains the `PayrollEvent` model (first model); a new migration `event-submission-api` adds the `payroll_events` table + `UNIQUE(idempotency_key)` + `UNIQUE(employee_id, sequence)`.
- **API surface:** new `POST /events` route on the existing NestJS app.
- **Tests:** unit tests for per-type DTO validation and `EventsService` dedupe paths; Supertest integration test against real Postgres in Docker (focused now — the full suite is change 10).
- **Dependencies:** none new.
- **Handoff note:** events persist with `status = 'received'`; change 3 (`bullmq-queue-integration`) marks `queued` on enqueue and refreshes the stored response body so duplicates continue to return the true state.

## Non-goals

- No queue, producer, or worker (change 3).
- No background processing / simulated payroll provider / handler registry (change 4).
- No retry or failure strategies (change 5).
- No `GET /events`, `GET /events/:id`, or history endpoints (change 8).
- No Redis warm-path cache for dedupe (defers to the DB; optional later).
- No Swagger/OpenAPI wiring (change 11).
- No authentication or rate limiting.