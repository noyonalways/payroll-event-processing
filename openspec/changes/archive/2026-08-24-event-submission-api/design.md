# Design: Event Submission API

## Context

The scaffold delivered a runnable NestJS 11 app: global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform) is already wired in `src/main.ts`, `EventsModule` is an empty stub, and `prisma/schema.prisma` has **no models**. This change makes the service accept, validate, dedupe, and persist employee payroll events — the submission contract that the queue (change 3) and worker (changes 4–7) will consume.

The three supported types and their required fields are recorded in the README:

| Event | Required fields |
|---|---|
| `BANK_ACCOUNT_CHANGE` | `employeeId`, `effectiveDate`, `iban` |
| `ADDRESS_CHANGE` | `employeeId`, `effectiveDate`, `street`, `city`, `postalCode`, `country` |
| `SALARY_CHANGE` | `employeeId`, `effectiveDate`, `newSalary`, `currency` |

Related decisions already locked in the architecture proposal: `idempotency_key` **NOT NULL + UNIQUE** (D1) and stored-response dedupe via `response_status`/`response_body` written in the same insert transaction (D2).

## Goals / Non-Goals

**Goals:**
- A single `POST /events` that validates per-type payloads, dedupes by `Idempotency-Key`, persists to `payroll_events`, and returns a fast `201 { id, status }`.
- A `payroll_events` schema + initial migration implementing D1/D2 invariants and per-employee `sequence` ordering.
- The idempotency core (R2) and ordering seed (R6) in place and unit/integration tested, before any queue exists.

**Non-Goals:**
- Queue producer/consumer, worker, simulated provider, retry/failure strategies (changes 3–5, 7).
- `GET` status/history endpoints (change 8).
- Swagger wiring (change 11).
- Redis dedupe warm-path cache (deferred; DB is arbiter per D2).
- Authentication / rate limiting.

## Decisions

### D1 — Request shape: nested `{ eventType, payload }` (not flat or per-type endpoints)

`POST /events` accepts `{ "eventType": "…", "payload": { … } }`.

**Reliability mapping:** R7 (extensibility), R2 (key applies uniformly to all types).
**Why:** the DB row stores `event_type` + `payload` (JSONB) as separate columns, so a nested shape maps 1:1; per-type validation lives in a small registry keyed by `eventType`, so a new event type = new payload DTO + one registry entry, with no controller/service change.
**Alternatives rejected:** flat single-DTO body (class-validator cannot express mutually-exclusive required-field sets cleanly on one object); one endpoint per type (`POST /events/<type>`) (diverges from the assignment + roadmap's single `POST /events`).

### D2 — Per-type payload validation via a registry, not statically-nested DTOs

Top-level `CreateEventDto` (`eventType` + `payload`) is validated by the existing global pipe. `payload` is validated by `PayloadValidator`: it maps `eventType` → payload DTO class and runs class-validator's `validate()` on a `plainToInstance()` copy.

**Files:** `src/events/dto/create-event.dto.ts`, `src/events/dto/payloads/{bank-account-change,address-change,salary-change}.dto.ts`, `src/events/event-type.ts` (enum + DTO-class registry in `src/events/dto/payload-registry.ts`).
**Rule surface:** `employeeId` `IsString`, `effectiveDate` `IsDateString`, `iban` `Matches(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/)` (no new dependency), `newSalary` `IsPositive` + `IsNumber`, `currency` `Length(3,3)`, plus `@IsString`/`@IsNotEmpty` for the address fields.
**Reliability mapping:** R7.
**Why:** the global pipe can't pick a payload type dynamically; explicit `validate()` gives full control of status codes and aggregated field-error messages, and the registry makes future types a drop-in.
**Alternatives rejected:** relying on `@ValidateNested` with a static inner type (only works for one payload shape); a giant conditional chain in the service (nothing new is "drop-in").

### D3 — Idempotency: insert-first with unique-violation fallback

Service flow for `createEvent`:
1. Read `Idempotency-Key` header (controller, `@Headers('idempotency-key')`). Missing → `BadRequestException` (`400`).
2. `findUnique({ idempotency_key })` — common duplicate path → return stored `response_status`/`response_body` immediately (no side effects).
3. Otherwise, run the insert transaction.
4. Catch `P2002` on `idempotency_key` (concurrent duplicate raced past the pre-check) → read the winning row → return its stored response.

**Reliability mapping:** R2 (no duplicate effects), R5 (the DB unique key is the arbiter).
**Why:** the unique constraint — not the pre-check — guarantees exactly-one-row; a pre-check alone has a TOCTOU window. Inserting first and treating the constraint violation as "duplicate" is the standard robust pattern; the pre-check just avoids redundant inserts on the hot path.
**Alternatives rejected:** skipping the pre-check (works, but pays an insert attempt + rollback on every duplicate); Redis-based dedupe (violates D2 — DB stays source of truth).

### D4 — `response_status` / `response_body` written in the same insert transaction (D2)

The `create` sets `responseStatus: 201` and `responseBody: { id, status: 'received' }` in the same statement. Duplicates return exactly this stored body. From change 3 onward, the queue/processing completion paths update these columns so duplicates keep returning the true current state — this change only defines the submission-time value.

**Reliability mapping:** R2.
**Why:** no TTL'd cache, no coherence failure modes; the stored response is always consistent with the DB row.

### D5 — Per-employee `sequence` computed under a per-employee advisory lock inside the insert transaction

In the insert transaction: `SELECT pg_advisory_xact_lock(hashtext($employeeId))`, then `SELECT COALESCE(MAX(sequence), 0) + 1 … WHERE employee_id = $1`, then `create` with that sequence.

**Reliability mapping:** R6 (monotonic per-employee ordering), R3 (no two inserts for one employee can interleave and produce duplicate sequences).
**Why:** `WHERE … FOR UPDATE` can't lock a not-yet-existing first row; `COUNT(*)+1` races; an xact advisory lock per employee serializes that employee's inserts (which the FIFO design wants anyway) while employees stay fully parallel.
**Alternatives rejected:** unique-violation-with-retry for `(employee_id, sequence)` (extra round-trips and error flow); timestamp-based sequence (not strictly monotonic under equal-ms).

### D6 — First model + migration

`PayrollEvent` added to `prisma/schema.prisma`:

```prisma
enum EventStatus { RECEIVED QUEUED PROCESSING SUCCESS FAILED }

model PayrollEvent {
  id              String      @id @default(uuid())
  eventType       String      @map("event_type")
  employeeId      String      @map("employee_id")
  payload         Json        @db.JsonB
  sequence        BigInt
  idempotencyKey  String      @unique @map("idempotency_key")
  status          EventStatus @default(RECEIVED) // map to lowercase in DB
  responseStatus  Int         @default(201) @map("response_status")
  responseBody    Json        @map("response_body")
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")
  processedAt     DateTime?   @map("processed_at")

  @@unique([employeeId, sequence])
  @@index([status])
  @@index([employeeId, createdAt])
  @@map("payroll_events")
}
```

Migration: `npx prisma migrate dev --name event-submission-api` (dev) / applied idempotently by the existing Docker entrypoint (`prisma migrate deploy`) in CI/envs.

**Reliability mapping:** R2 (unique key), R6 (employee+sequence unique + index).
**Why:** the full status enum is defined once here so later changes (3–7) only consume it; `BigInt` sequence avoids overflow as volume grows.

### D7 — Response and error contracts

- Success / duplicate: HTTP `201` with the stored `{ id, status: 'received' }` body (from `response_body`).
- Missing key / invalid payload / unknown type / unknown fields: HTTP `400` with the existing `HttpExceptionFilter` shape (`{ statusCode, message, error, timestamp, path }`); validation failures carry per-field messages.

**Reliability mapping:** R2; consistent API surface for tests and the future frontend.

## Risks / Trade-offs

- **Fast-path pre-check + insert race** → handled: `P2002` catch re-reads and returns the stored response; DB remains the arbiter. Covered by the "Concurrent duplicate submissions" spec scenario.
- **Advisory lock serializes inserts per employee** → intentional (per-employee FIFO ordering is the design); different employees are unaffected. Sequence throughput per employee is bounded, which matches the queue's per-employee FIFO semantics.
- **`sequence` is a `BigInt` in Prisma** → Prisma returns it as a JS `BigInt`, which `JSON.stringify` cannot serialize. `sequence` is **not** part of the HTTP response this change returns, so it never hits serialization; when later changes expose it (status/history API), the service will map it to a string.
- **`status: 'received'` in the 201 body diverges from the final system's `'queued'`** → intentional scoping: the queue doesn't exist yet, so `received` is the honest persisted state. Change 3 will transition to `queued` and update stored responses (a spec `MODIFIED` on the submission requirement).
- **IBAN check is a format regex, not a checksum** → sufficient for the simulated provider and avoids a new dependency; a strict checksum library can be swapped in later without API change.

## Migration Plan

1. Update `prisma/schema.prisma` with the enum + model.
2. `npx prisma migrate dev --name event-submission-api` creates the `payroll_events` table + indexes/constraints.
3. Deploy path unchanged: `docker-entrypoint.sh` already runs `prisma migrate deploy` before starting the API; CI applies migrations on test setup.
4. Rollback: additive change (new table only) — dropping the table/migrations is a safe reverse.

## Open Questions

None blocking for this change. Planned handoff (not a decision needed now): the worker's later completion transactions must refresh `response_status`/`response_body` so stored responses track the final outcome — tracked in changes 3/7.