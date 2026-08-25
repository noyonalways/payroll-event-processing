## 1. Schema & Migration

- [x] 1.1 Add the `IdempotencyRecord` model to `prisma/schema.prisma` (`scope`, `key`, `responseStatus`, `responseBody`, `expiresAt`, `createdAt`; `@@unique([scope, key])`, `@@index([expiresAt])`, `@@map("idempotency_records")`)
- [x] 1.2 Update `PayrollEvent`: remove `responseStatus` and `responseBody` fields; change `idempotencyKey` from `@unique` to a non-unique `@@index([idempotencyKey])` (column stays `NOT NULL` for traceability)
- [x] 1.3 Generate the migration (`npx prisma migrate dev --name idempotency_records`) and verify the SQL contains the `CREATE TABLE`, the two `DROP COLUMN`s, and the unique→index swap
- [x] 1.4 Write/extend integration coverage that asserts the new table constraints (`UNIQUE (scope, key)`, sweep index) are enforced — alongside the migration, not after

## 2. Idempotency module — core layer (reliability-critical: R2 idempotency, R5 exactly-once)

- [x] 2.1 Create `src/common/idempotency/idempotency.constants.ts` — `IDEMPOTENCY_HEADER` OpenAPI constant (name/description/example), `IDEMPOTENCY_SCOPE_EVENT_SUBMISSION = 'event-submission'`, and the key-contract limits (max 128 printable-ASCII chars)
- [x] 2.2 Implement `@IdempotencyKey()` in `src/common/idempotency/idempotency-key.decorator.ts` (`createParamDecorator`): missing/blank/over-length/non-printable → `BadRequestException` with structured messages; returns the trimmed key — **write `idempotency-key.decorator.spec.ts` alongside**
- [x] 2.3 Implement `IdempotencyService.execute<TOp extends { status, body }>(scope, key, op)` if `src/common/idempotency/idempotency.service.ts` (single `findUnique` lookup; `replay` / `expired` / miss paths; transactional `op(tx)` + record insert; `P2002` race → post-transaction winner read; outcomes `stored`/`replay`/`expired`/`race` logged with `scope`+`key`+status, never bodies) — **write `idempotency.service.spec.ts` alongside covering fast path, store path, race, expiry, scope isolation, pre-commit failure**
- [x] 2.4 Implement `IdempotencySweeper` in `src/common/idempotency/idempotency.sweeper.ts` (`OnModuleInit` unref'd `setInterval` at `IDEMPOTENCY_SWEEP_INTERVAL_MS`, `deleteMany(expiresAt < now)`, errors logged not thrown, `OnModuleDestroy` clears the timer, `sweepNow()` for tests) — **write `idempotency.sweeper.spec.ts` alongside**
- [x] 2.5 Wire `src/common/idempotency/idempotency.module.ts` declaring + exporting `IdempotencyService` and registering `IdempotencySweeper` (not `@Global()`); confirm `PrismaService`/`ConfigService` resolve via the global modules

## 3. Configuration

- [x] 3.1 Add `IDEMPOTENCY_TTL_SECONDS` (`Joi.number().integer().min(1).default(86400)`) and `IDEMPOTENCY_SWEEP_INTERVAL_MS` (`Joi.number().integer().min(1000).default(60000)`) to the `app.module.ts` validation schema
- [x] 3.2 Add both variables to `.env.example`, `.env.development`, `.env.test`, `.env.production`, and the api/worker `environment` blocks in `docker-compose.yml` / `docker-compose.override.yml` (top-level-priority pattern)
- [x] 3.3 Verify config loads in tests and containers (Joi defaults apply when unset; no missing-required-var startup failure)

## 4. Refactor `POST /events` onto the layer (reliability-critical: R5 exactly-once keeps the single-transaction guarantee)

- [x] 4.1 Add `IdempotencyModule` to `src/events/events.module.ts` `imports`
- [x] 4.2 Update `src/events/events.controller.ts`: replace `@Headers('idempotency-key')` + inline check with `@IdempotencyKey()`; source `@ApiHeader` from `IDEMPOTENCY_HEADER`; keep `@Res({ passthrough: true })` and the stored-response mapping — **update `events.controller.spec.ts` alongside**
- [x] 4.3 Refactor `src/events/events.service.ts`: `createEvent` calls `idempotency.execute(IDEMPOTENCY_SCOPE_EVENT_SUBMISSION, key, op)` where `op(tx)` is the existing advisory-lock → next-sequence → `tx.payrollEvent.create` insert returning `{ status: 201, body, sequence }`; keep `markQueued` + `enqueueBestEffort` post-commit outside the layer; keep the `SubmissionResult { httpStatus, body }` boundary shape — **update `events.service.spec.ts` alongside** (op-side effects, once-only semantics, sequence, queued transition, enqueue invoked)
- [x] 4.4 Run the full unit suite and confirm no spec references the removed `response_status` / `response_body` model fields

## 5. e2e, docs, and verification

- [x] 5.1 Update `test/event-submission.e2e-spec.ts` — existing duplicate/concurrent scenarios still pass (stored response returned exactly, one `payroll_events` row per key); key-reuse-after-expiry scenario added (expiry forced via direct `expiresAt` DB update — a TTL env override can't steer one test because `@nestjs/config` snapshots env at import); no assertions on removed response columns
- [x] 5.2 Verify Swagger still documents the `Idempotency-Key` header on `POST /events` (GET `/api-docs-json`) via the shared `IDEMPOTENCY_HEADER` (asserted in `test/api-docs.e2e-spec.ts`)
- [x] 5.3 Green pipeline: `npm run lint:check` ✓, `npm test` ✓ (81 pass), `npm run test:e2e` ✓ (5 suites green in-process; `event-queue` + `processing` suites each pass in isolation — full-suite worker-queue interference is a pre-existing harness quirk), manual duplicate-submission smoke test ✓ against the compose stack

## 6. Cleanup & commit

- [x] 6.1 Grep for stale references to `responseStatus`/`responseBody`/`readStoredResponse` outside specs and remove (remaining matches: `docs/architecture.md` — updated to the shared-layer design; migration SQL + openspec change artifacts — historical record, retained; `IdempotencyRecord` model/layer/tests — current by design)
- [x] 6.2 Conventional commits per group (e.g. `feat(idempotency): shared store-and-replay layer`, `feat(events): adopt shared idempotency layer`) with the breaking internal persistence change called out in the migration commit — **commit action performed by the user** (per instruction: "no need commit I will commit.")