# Design — event-status-api

## Context

The service persists every accepted event as a `payroll_events` row whose `status` advances `received → queued → processing → success | failed`, and since the `concurrency-and-crash-recovery` change keeps an append-only `event_attempts` audit trail (one row per *terminal* attempt, written atomically with the terminal transition). `POST /events` returns immediately with `{ id, status: "received" }`; `GET /health` reports process/dependency health. There is **no read endpoint** — an operator or consumer wanting to know where an event is, whether it succeeded, or why it failed must query the database directly.

This change adds the missing read surface: `GET /events/{id}` returning the event's committed lifecycle state, its details, and its terminal-attempt history.

### Constraints
- NestJS 11 + `@nestjs/swagger` (decorator-driven OpenAPI); the API and worker share `src/` (worker is `apps/worker/src/main.ts`).
- `sequence` is `BigInt` in Prisma/Postgres — not directly JSON-serializable.
- `event_attempts` is append-only and indexed on `event_id` (`@@index([eventId])`); `payroll_events` has no index on `id` besides the PK lookup.
- The transactional claim (design D1 of `concurrency-and-crash-recovery`) commits the claim and terminal write together, so a committed `processing` row is effectively never observable across transaction boundaries.
- No schema/storage changes are needed: the read is pure `SELECT` over existing tables (rules: describe schema changes explicitly → *none*).

## Goals / Non-Goals

**Goals:**
- Expose `GET /events/{id}` returning HTTP 200 with the current `status` and full event detail (`eventType`, `employeeId`, `sequence`, `payload`, timestamps, `result`) plus the `event_attempts` terminal history ordered by `attemptNumber`.
- Return HTTP 404 with the existing structured `ErrorResponseDto` for unknown ids (reuses the global `HttpExceptionFilter`).
- Document the operation and its typed response (`EventStatusResponseDto`, `EventAttemptDto`) in Swagger/OpenAPI.
- Cover the read path in unit and e2e tests, including the success/failed attempt-trail assertions.

**Non-Goals:**
- No list / query-by-employee endpoint (filtering + pagination are future work).
- No mutation via this API (no cancel/retry/re-enqueue) — read-only.
- No authN/authZ (consistent with the rest of the service).
- No changes to `POST /events`, the queue, the worker, or the DB schema.
- No redaction/field-level access control on `payload`/`result` (flagged in Open Questions).

## Decisions

### D1 — Extend `EventsController`/`EventsService` rather than introduce a new module
Add `@Get(':id')` to the existing `src/events/events.controller.ts` and a `getEventStatus(id)` method to `src/events/events.service.ts`.

**Why:** the resource is the same (`payroll_events`); the read is a trivial `findUnique` + `findMany`, so a dedicated module/service adds indirection without value. Keeping one controller keeps the OpenAPI `events` tag coherent — `POST /events` and `GET /events/{id}` under one roof, exactly like the previous changes' health/queue surface. (Reliability: observability — R4's "know where an event is".)
**Alternatives:** (a) a separate `EventStatusController`/`EventStatusService` — rejected as overhead for two queries; (b) a GraphQL/DTO-less endpoint — rejected, the service is REST + Swagger by convention.

### D2 — Two sequential reads: `payrollEvent.findUnique` then `eventAttempt.findMany`
- `src/events/events.service.ts`:
  - `this.prisma.payrollEvent.findUnique({ where: { id } })` → if null, throw `NotFoundException`.
  - `this.prisma.eventAttempt.findMany({ where: { eventId: id }, orderBy: { attemptNumber: 'asc' } })`.
- Map both into `EventStatusResponseDto` (see D4 for `BigInt`/date handling).

**Why:** the two tables are related but need no `JOIN`; `findUnique` uses the PK, `findMany` uses the existing `@@index([eventId])`. `event_attempts` is append-only, so no deletar/update race. Two reads under READ COMMITTED are effectively consistent for our purposes: the event row is mutated by `EventClaim`'s single guard, and attempts are written only inside the same committed tx as a terminal transition (D1 of the prior change) — so an attempt row always appears *with* its terminal status, never before it. (Reliability: R5 exactly-once — the attempt trail is only visible once the event's terminal state commits.)
**Alternatives:** (a) `$transaction` array of both reads for a strict snapshot — marginally stricter isolation at the cost of ceremony; not needed because accounts above; (b) a raw SQL join — rejected, loses Prisma types and stays in builder territory.

### D3 — 404 via `NotFoundException` → global filter → `ErrorResponseDto`
`getEventStatus` throws Nest's `NotFoundException('Event not found')`; the existing global `src/common/filters/http-exception.filter.ts` shapes it into `{ statusCode: 404, message, error, timestamp, path }` — the same `ErrorResponseDto` already referenced by `POST /events`' 400 and Swagger-documented.

**Why:** zero new error plumbing; the API's error contract stays uniform (`ErrorResponseDto` for all documented non-2xx).

### D4 — Explicit serialization of `BigInt` and `DateTime` in the service mapping
`sequence` is `BigInt`; dates serialize as ISO strings by JSON conventions but the mapping coerces explicitly:
- `sequence: Number(row.sequence)` (same convention as the queue job data and the FIFO relay).
- `processedAt`/`result` stay `null` when unset (nullable columns), else pass through.
- `attempts` copied from the `findMany` result with field names aligned to snake_case → camelCase (Prisma already does the mapping).

**Why:** `JSON.stringify` throws on `BigInt`; coercing in the service (the API boundary) keeps DTOs JSON-safe and matches the pattern established by `PayrollEventQueueService`/`relayNextPending`. (Reliability: none — correctness/serialization.)

### D5 — Swagger annotations on a new response DTO pair
New files:
- `src/events/dto/event-attempt.dto.ts` — `EventAttemptDto` (`attemptNumber`, `status`, `errorType`, `failedReason`, `result`, `createdAt`) with `@ApiProperty` descriptions/examples.
- `src/events/dto/event-status-response.dto.ts` — `EventStatusResponseDto` (`id`, `eventType`, `employeeId`, `sequence`, `status`, `payload`, `createdAt`, `updatedAt`, `processedAt`, `result`, `attempts: EventAttemptDto[]`) with `@ApiProperty`.
Controller: `@Get(':id')` + `@ApiOperation` + `@ApiParam({ name: 'id' })` + `@ApiOkResponse({ type: EventStatusResponseDto })` + `@ApiNotFoundResponse({ type: ErrorResponseDto })` + `@ApiTags('events')` (existing).

**Why:** matches the decorator-driven OpenAPI contract already in use (`EventSubmissionResponseDto`, `HealthResponseDto`); the api-documentation delta requires the typed 200/404 and the component schemas. (Reliability: observability/docs.)

### D6 — No idempotency, and read-only semantics are implied (no mutation)
The endpoint takes no `Idempotency-Key` header and performs only `SELECT`s. The spec (event-status-api delta) pins both explicitly, so the requirement and this design agree.

## Risks / Trade-offs

- **[Risk] `BigInt` serialization blow-up** (a `sequence` leaking into a response without conversion throws). → Mitigation: **D4** coerces to `Number` at the service boundary; unit test asserts a JSON round-trip.
- **[Risk] Observing `processing` in a response.** With the transactional claim, a committed `processing` row is transient/effectively never visible. → The DTO/status enum still supports it for completeness; the spec requires `queued` between retries, and tests only drive committed states.
- **[Risk] Attempt list grows** (many terminal attempts per event). → Bounded by `PAYROLL_MAX_RETRY_ATTEMPTS` (default 5) + one exhaustion row; no pagination needed now. Flagged as future work if retry counts grow.
- **[Trade-off] Payload/result are returned in full** (bank account IBANs, salaries). The service has no authN; this is consistent with `POST /events` accepting them openly, but field-level redaction is a future consideration (Open Questions).
- **[Risk] Two reads are not a strict snapshot.** → Covered in **D2**: append-only attempts + single-writer event rows make torn reads effectively nil.

## Migration Plan

1. Add the two DTOs (`event-attempt.dto.ts`, `event-status-response.dto.ts`), the `getEventStatus` service method + `NotFoundException`, and the `@Get(':id')` controller route.
2. No DB migration — read-only over existing tables (`event_attempts` index already present from the worker-recovery migration).
3. Unit tests (`src/events/events.controller.spec.ts`, `src/events/events.service.spec.ts`) for the mapping, attempt ordering, and 404; e2e (`test/event-status.e2e-spec.ts`) driving a real event to `queued` → `success` / `failed` and reading it back with its attempts; assert `/api-docs-json` documents the new schemas.
4. Rollback: remove the controller route + service method; no data or schema impact.

## Open Questions

- Whether `payload`/`result` should ever be redacted (the values are sensitive; the system currently has no authN and `POST /events` stores them in full). Deferred as a separate security change if needed.
- Whether future consumers need attempt **pagination** (only relevant if max retries grow beyond the current default of 5).