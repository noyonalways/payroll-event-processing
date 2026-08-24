## 1. Prisma Schema & Migration

- [x] 1.1 Add `EventStatus` enum and `PayrollEvent` model to `prisma/schema.prisma` per design D6 (snake_case `@map`s, `idempotency_key` `@unique`, `@@unique([employeeId, sequence])`, indexes on `status` and `[employeeId, createdAt]`, `response_status`/`response_body` NOT NULL written at insert)
- [x] 1.2 Run `npx prisma migrate dev --name event-submission-api` to create + apply the migration; inspect the generated SQL and confirm the table, both unique constraints, and both indexes are present
- [x] 1.3 Verify `npx prisma generate` output compiles with the existing `PrismaService` and strict TypeScript

## 2. Event Types, DTOs & Payload Validation

- [x] 2.1 Create `src/events/event-type.ts` — `EventType` enum (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`)
- [x] 2.2 Create `src/events/dto/create-event.dto.ts` — top-level `{ eventType, payload }` with class-validator (`@IsEnum`, `payload` as record)
- [x] 2.3 Create per-type payload DTOs in `src/events/dto/payloads/`: `bank-account-change.dto.ts` (`employeeId`, `effectiveDate` `@IsDateString`, `iban` with IBAN-format `@Matches`), `address-change.dto.ts` (6 required fields), `salary-change.dto.ts` (`newSalary` `@IsPositive`/`@IsNumber`, `currency` `@Length(3,3)`), each with `@IsString`/`@IsNotEmpty` on text fields
- [x] 2.4 Create `src/events/dto/payload-registry.ts` mapping `EventType` → payload DTO class (registry keyed by type — new types are a drop-in)
- [x] 2.5 Create `src/events/payload.validator.ts` — resolve DTO by `eventType` (unknown type → `BadRequestException`), `plainToInstance` + `validate()` from class-validator, aggregate per-field messages into a `400`

## 3. Service: Idempotency + Transactional Insert ⚠️ reliability-critical (R2 dedupe, R6 sequence)

- [x] 3.1 ✔ Implement `EventsService.createEvent({ eventType, payload, idempotencyKey })`: fast-path `findUnique` dedupe returning the stored `response_status`/`response_body` with **no side effects**
- [x] 3.2 ⚠️ Implement the insert transaction (design D3/D5): `pg_advisory_xact_lock(hashtext(employeeId))` → next `sequence` (`MAX+1`) → `create` row with `status: RECEIVED`, `responseStatus: 201`, `responseBody: { id, status: 'received' }`
- [x] 3.3 ⚠️ Catch `P2002` on `idempotency_key` (concurrent duplicate) → re-read the winning row and return its stored response (no second row, no 500)
- [x] 3.4 Ensure `sequence` (Prisma `BigInt`) is never placed on the HTTP response; log with context (`eventId`, `employeeId`, `eventType`)

## 4. Controller & Module Wiring

- [x] 4.1 Create `src/events/events.controller.ts` — `POST /events`, read `Idempotency-Key` via `@Headers('idempotency-key')`, missing header → `400`; return stored `201` body on success and on duplicate
- [x] 4.2 Update `src/events/events.module.ts` (replace empty stub) to register `EventsController`, `EventsService`, `PayloadValidator`

## 5. Unit Tests (written alongside implementation)

- [x] 5.1 Validate each payload DTO with class-validator against the spec scenarios: valid submit for all 3 types, missing required field, unknown field rejected, malformed value (`newSalary` non-numeric), invalid IBAN
- [x] 5.2 `EventsService` unit tests (mocked `PrismaService`): new event inserts once + returns `201 { id, status: 'received' }`; duplicate key returns stored response and does not insert; `P2002` race returns stored response; monotonic per-employee sequence increments
- [x] 5.3 `EventsController` unit test: delegates header + DTO to service; missing `Idempotency-Key` → `400`

## 6. Integration / E2E (Docker Postgres)

- [x] 6.1 Create `test/event-submission.e2e-spec.ts` (Supertest, real DB): each type submits → `201` `{ id, status: 'received' }`
- [x] 6.2 Same suite: missing key → `400`; unsupported type → `400`; missing field → `400`; unknown field → `400`
- [x] 6.3 ☑ Idempotency e2e: same key twice → identical `201` body, exactly one row for the key; concurrent duplicate submissions → one row, both get a stored response
- [x] 6.4 Sequence e2e: two events for one employee → second `sequence` = first + 1; different employees have independent counters (assert via Prisma query)
- [x] 6.5 Run `npm run test:e2e` with Docker Postgres up and make it green

## 7. Verification

- [x] 7.1 `npm run lint:check` and `npm run build` pass clean
- [x] 7.2 `npm run test` (unit) green
- [x] 7.3 Smoke-test `POST /events` against the running compose stack with curl (201) and duplicate key (same body)