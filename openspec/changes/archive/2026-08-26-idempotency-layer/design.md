## Context

Idempotency is currently bespoke logic baked into the events submission path. `EventsController.create` (`src/events/events.controller.ts:67`) hand-checks the `Idempotency-Key` header, and `EventsService` (`src/events/events.service.ts`) owns fast-path dedupe, the transactional insert, the unique-violation race handling, and the stored response — which lives as the `response_status` / `response_body` columns on the `payroll_events` row itself (`prisma/schema.prisma`). That coupling means a second endpoint cannot reuse any of it, the response store cannot expire, and the storage grows without bound.

This change lifts idempotency into a first-class shared layer in `src/common/idempotency/`: a validating `@IdempotencyKey()` parameter decorator, a generic store-and-replay `IdempotencyService.execute(scope, key, op)`, a dedicated `idempotency_records` store with TTL, and a sweep that bounds its size. `POST /events` is refactored to consume the layer under the `event-submission` scope; the external API contract is unchanged.

Constraints from the existing codebase that shape the design:

- **PrismaModule is `@Global()`** (`src/prisma/prisma.module.ts`), so `PrismaService` injects anywhere without importing the module.
- **No scheduler dependency** in `package.json` — a sweep that adds a dependency (e.g. `@nestjs/schedule`) is a trade to avoid.
- **`@Global()` ConfigModule with Joi validation** in `src/app.module.ts` — the TTL setting must be added to that Joi schema and to `.env.*` + docker-compose following the top-level-priority pattern.
- The **existing HTTP 400 contract** flows through the global `HttpExceptionFilter` (`src/common/filters/http-exception.filter.ts`) producing the `ErrorResponseDto` shape — the decorator only needs to throw `BadRequestException` with the same message the controller uses today.
- The **post-commit behaviors must not move** into the layer: `markQueued` and best-effort enqueue stay in `EventsService` so the 201 never depends on Redis state.

## Goals / Non-Goals

**Goals:**
- Provide a reusable `@IdempotencyKey()` decorator that parses and validates the header (required, trimmed, printable-ASCII, ≤128 chars) and yields structured `400`s — generalizing the controller's inline check.
- Provide a generic `IdempotencyService.execute(scope, key, op)` with exact-once store-and-replay semantics: fast-path replay, transactional persistence of the operation's state changes + response record, and unique-constraint race handling that serves the winner's stored response.
- Introduce a dedicated `idempotency_records` store with `UNIQUE (scope, key)` and TTL expiry, plus a periodic sweep so storage stays bounded.
- Refactor `POST /events` onto the layer under scope `event-submission` with no change to the external contract.
- Mitigate the schema coupling: drop `response_status` / `response_body` from `payroll_events` and resolve the `UNIQUE (idempotency_key)` tension so key reuse after expiry works.

**Non-Goals:**
- Worker-side exactly-once (event state transitions) — that machinery stays as-is; this change is the API/submission layer only.
- Changing the external submission contract, response bodies, status codes, or the `@ApiHeader` documentation of the header.
- Distributed locking beyond the existing PostgreSQL unique constraint and per-employee advisory locks.
- Authentication, metrics dashboards, or alerting.

## Decisions

### D1 — `@IdempotencyKey()` is a pure parameter decorator (no DI)
**File:** new `src/common/idempotency/idempotency-key.decorator.ts`

Implement with `createParamDecorator`: read `req.headers['idempotency-key']`, validate presence / trim / non-blank / printable-ASCII / ≤128 chars, and either return the trimmed key or `throw new BadRequestException('Idempotency-Key header is required')` (blank, over-length, and non-printable values use a specific message naming the violation). Validation is pure string logic, so the decorator needs no injected service; the global `HttpExceptionFilter` shapes the response into the existing `ErrorResponseDto` body. Because it throws the same exception class the controller throws today (`src/events/events.controller.ts:73`), the external 400 body is uniform.

Reliability concept: **R2 idempotency** — the key contract (required, shape, length) is enforced before any operation can run.

**Swagger note:** a parameter decorator cannot emit OpenAPI header metadata — `@ApiHeader` only attaches at method/controller level. So the OpenAPI header definition moves to a shared constant `IDEMPOTENCY_HEADER` (name, description, example) in new `src/common/idempotency/idempotency.constants.ts`, referenced by the controller's `@ApiHeader(...)`. Single source of truth for runtime validation and docs; this is the implementable version of the proposal's "docs via the shared layer" — fully automatic swagger from a param decorator is not idiomatic NestJS.

**Alternatives considered:** keep the inline `@Headers()` + hand-check per endpoint (rejected — the exact duplication this change removes); a custom validation pipe or interceptor (rejected — heavier than needed; the spec names a parameter decorator).

### D2 — `IdempotencyService.execute(scope, key, op)` where `op(tx)` joins the caller's transaction
**File:** new `src/common/idempotency/idempotency.service.ts`

Signature:

```ts
type IdempotencyOutcome = 'stored' | 'replay' | 'expired' | 'race';
interface IdempotencyOpResult {
  status: number;                 // HTTP status persisted in the record
  body: Record<string, unknown>;  // response body persisted in the record
}
execute<TOp extends IdempotencyOpResult>(
  scope: string,
  key: string,
  op: (tx: Prisma.TransactionClient) => Promise<TOp>,
): Promise<TOp>;
```

The generic `TOp` lets callers return extra fields (`sequence`, etc.) that flow back to them while the layer persists only `status`/`body`. Algorithm:

1. `findUnique(where: { scope_key: { scope, key } })` — single lookup, no expiry filter.
2. Record exists and `expiresAt > now` → log `replay` (with stored status) → return stored `{ status, body }`, `op` never runs.
3. Record exists but `expiresAt <= now` → log `expired` → treat as absent, continue.
4. Miss/expired → `prisma.$transaction(async tx => { const result = await op(tx); await tx.idempotencyRecord.create({ scope, key, responseStatus: result.status, responseBody: result.body, expiresAt: now + TTL }); return result; })`. Commit → log `stored` → return.
5. `P2002` (unique `(scope, key)` violation) thrown out of the transaction → the concurrent winner committed. The loser transaction — including the `op` state changes — rolled back automatically, so at the DB level `op` ran once. Log `race`; post-transaction `findUnique` the winner and return the stored response (its `expiresAt` was set to `now + TTL` at creation, so it is non-expired); if it is somehow absent, rethrow.

This retains dedupe even across an expiry boundary: two concurrent requests for an expired key both run `op`, but only one insert commits; the loser's state changes roll back and both callers get the winner's stored response — exactly-once is preserved at the unique-constraint edge, not just mid-window.

Reliability concepts: **R2** idempotency (unique arbiter), **R5** exactly-once (op + record in one transaction, so a failure before commit leaves no side effects and no record), **R7** extensibility (any endpoint can adopt the layer).

**Alternatives considered:** pre-insert the record and update it after `op` (rejected — ordering within the tx is equivalent, and insert-after-op makes the failure path "rollback leaves nothing" trivially true); let callers pass a raw Prisma client and manage transactions themselves (rejected — that leaks the very coupling the layer exists to remove).

### D3 — Dedicated `idempotency_records` store
**File:** `prisma/schema.prisma` (new model) + `prisma/migrations/*` (new migration)

```prisma
model IdempotencyRecord {
  id             String   @id @default(uuid())
  scope          String   @map("scope")
  key            String   @map("key")
  responseStatus Int      @map("response_status")
  responseBody   Json     @map("response_body")
  expiresAt      DateTime @map("expires_at")
  createdAt      DateTime @default(now()) @map("created_at")

  @@unique([scope, key])
  @@index([expiresAt])
  @@map("idempotency_records")
}
```

- `@@unique([scope, key])` is the idempotency arbiter — Postgres enforces exactly-one-record-per-operation, so concurrency is resolved by the database, not by app code (same philosophy as today's `UNIQUE (idempotency_key)`).
- `@@index([expiresAt])` serves the sweep's `deleteMany({ where: { expiresAt: { lt: now } } })`.
- `scope` is a string so future endpoints (e.g. `event-submission`, `payout-create`) self-register without schema changes.

Reliability concept: **R2** idempotency — reuse of the unique-constraint-as-arbiter strategy already proven in the service.

**Alternatives considered:** keep the response on `payroll_events` (today's design — rejected: couples the response store to one table, unreusable, no TTL); a TTL-on-the-event-row approach (rejected — would delete event history to free response space).

### D4 — Drop `response_status` / `response_body` and the `UNIQUE (idempotency_key)` on `payroll_events`
**File:** `prisma/schema.prisma` (PayrollEvent model) + new migration

Two schema changes in the same migration:

1. `ALTER TABLE "payroll_events" DROP COLUMN "response_status", DROP COLUMN "response_body";`
2. Replace `idempotencyKey String @unique` with `idempotencyKey String @map("idempotency_key")` plus a non-unique `@@index([idempotencyKey])` — the column stays `NOT NULL` for traceability (per spec), but uniqueness moves off `payroll_events`.

The second change is *required*, not incidental: with the arbiter now in `idempotency_records`, a lingering `UNIQUE (idempotency_key)` on `payroll_events` would make the spec's key-reuse-after-expiry scenario impossible — the original row still occupies the key, so a fresh post-expiry event row could never be inserted. Removing the unique frees the key for a new event while the dedupe within the TTL window continues to be enforced by `idempotency_records`.

Reliability concept: **R2** idempotency correctness across TTL boundaries; **R1/R5** the DB row remains the authoritative persistence record.

### D5 — TTL via env config and a lifecycle-hook sweep (no new scheduler dependency)
**Files:** `src/common/idempotency/idempotency.sweeper.ts` (new), `src/app.module.ts`, `.env.example` / `.env.development` / `.env.test` / `.env.production`, `docker-compose.yml` / `docker-compose.override.yml`

- `IDEMPOTENCY_TTL_SECONDS` — Joi `Joi.number().integer().min(1).default(86400)` in the `app.module.ts` validation schema; read by `IdempotencyService` via `ConfigService` when computing `expiresAt`.
- `IDEMPOTENCY_SWEEP_INTERVAL_MS` — Joi `.number().integer().min(1000).default(60000)`.
- `IdempotencySweeper` (`@Injectable`, registered in the module) implements `OnModuleInit` / `OnModuleDestroy`: start an unref'd `setInterval` that calls `deleteMany({ where: { expiresAt: { lt: now() } } })`; clear on destroy. Errors are logged and never fatal (a missed sweep is recoverable by the next tick). A manual `sweepNow()` method is exposed for tests.

Reliability concept: **R2** idempotency retention — bounded store growth via TTL + sweep.

**Alternatives considered:** `@nestjs/schedule` `@Cron` (rejected — adds a dependency for one interval; lifecycle-hook interval matches the repo's minimal-dependency idiom and is directly unit-testable); a DB-side `pg_cron` job (rejected — couples scheduling to the database and is not available in the test docker topology).

### D6 — Module wiring and the `POST /events` refactor
**Files:** `src/common/idempotency/idempotency.module.ts` (new), `src/events/events.module.ts`, `src/events/events.controller.ts`, `src/events/events.service.ts`

- `IdempotencyModule` declares `IdempotencyService` + `IdempotencySweeper`, exports `IdempotencyService`. It imports nothing (PrismaModule is `@Global()`; `ConfigService` is global via `ConfigModule.forRoot({ isGlobal: true })`). **Do not** mark it `@Global()` — callers opt in per module.
- `EventsModule` adds `IdempotencyModule` to `imports`.
- `EventsController.create` swaps `@Headers('idempotency-key')` for `@IdempotencyKey()`; keeps `@Res({ passthrough: true })` and the `result.httpStatus` / `result.body` mapping so the stored response — now read back from `idempotency_records` — is returned exactly.
- `EventsService.createEvent` becomes: validate payload → derive `employeeId` → `this.idempotency.execute(SCOPE_EVENT_SUBMISSION, key, op)` where `op(tx)` is today's transactional insert exactly as-is: `pg_advisory_xact_lock(hashtext(employeeId))`, `SELECT MAX(sequence)+1`, `tx.payrollEvent.create(...)`, returning `{ status: 201, body: { id, status: 'received' }, sequence }`. The layer persists `status`/`body`; `sequence` flows back for the enqueue.
- **Post-commit remains in `EventsService`:** `markQueued(id, employeeId)` then `enqueueBestEffort(...)` run after `execute` resolves — never inside `op`. The 201 keeps its "never depends on Redis" guarantee and the `received → queued` transition stays as-is.
- The store + event row commit together in `execute`'s transaction, so a crash before commit leaves neither — preserving today's exactly-once guarantee.

New scope constant: `SCOPE_EVENT_SUBMISSION = 'event-submission'` in `idempotency.constants.ts`. Existing `SubmissionResult { httpStatus, body }` public shape is preserved at the `EventsService` boundary to keep the controller and e2e contract untouched.

Reliability concepts: **R5** exactly-once (single transaction), **R1** temporary-failure isolation (post-commit best-effort enqueue unchanged).

### D7 — Structured observability
**File:** `src/common/idempotency/idempotency.service.ts`

A single `logDecision(scope, key, outcome, httpStatus, extra?)` in `IdempotencyService` (NestJS `Logger`). Outcomes match the spec exactly: `stored`, `replay`, `expired`, `race`; always include `scope`, `key`, and the returned HTTP status. Keys are logged; **payloads and response bodies are never logged**. `EventsService` keeps its existing event-scoped logs (`eventId`, `employeeId`, `eventType`) as today.

Reliability concept: **observability** — every dedupe decision is a distinct, greppable event; the `expired` outcome is explicitly distinct from `stored`.

### D8 — Test strategy
**New unit specs:**
- `src/common/idempotency/idempotency-key.decorator.spec.ts` — missing / blank / over-length / non-printable → `BadRequestException`; printable ≤128 with surrounding whitespace → trimmed key returned.
- `src/common/idempotency/idempotency.service.spec.ts` (mocked `PrismaService`) — first request stores (`op` runs once, record persisted, `stored` logged); duplicate replays without invoking `op`; `P2002` race → winner read post-transaction (`race` logged); expired record → `expired` logged + `op` re-runs + fresh record replaces; failure before commit → no record, error propagated; scopes isolate (same key, different scopes don't dedupe).
- `src/common/idempotency/idempotency.sweeper.spec.ts` — `deleteMany` called with `expiresAt < now`; errors logged not thrown; timer cleared on destroy.

**Refactored specs:** `src/events/events.controller.spec.ts`, `src/events/events.service.spec.ts` — assert the external contract is identical (400 on missing header, 201 body `{ id, status: 'received' }`, sequence increments, `queued` transition + enqueue invoked) with `IdempotencyService` mocked.

**e2e:** `test/event-submission.e2e-spec.ts` — existing duplicate scenarios still pass (stored response returned exactly, one `payroll_events` row per key, concurrent duplicates collapse to one row); add a key-reuse-after-expiry scenario by running the e2e suite with a small `IDEMPOTENCY_TTL_SECONDS` override; update any assertions that referenced the removed `response_status` / `response_body` columns.

## Risks / Trade-offs

- **[Stored responses lost on column drop]** → any key submitted before deploy and re-submitted within its window would create a new event instead of replaying. → Mitigation: acceptable for this development-stage repo and short 24-h windows; if continuity matters, the migration may backfill `INSERT INTO idempotency_records (scope, key, response_status, response_body, expires_at) SELECT 'event-submission', idempotency_key, response_status, response_body, created_at + make_interval(secs => ${TTL}) FROM payroll_events;`.
- **[Sweep races a read on the same expired record]** → both callers may run `op` and attempt an insert. → Mitigation: `UNIQUE (scope, key)` is still the arbiter — only one insert commits, the loser's `op` state changes roll back, both callers receive the winner's stored response. Exactly-once survives even mid-sweep.
- **[Every submission now costs a read + write on `idempotency_records`]** → small constant overhead vs today's single-table write. → Mitigation: the fast path is one compound-unique indexed lookup; the write is in the existing transaction. Acceptable for the submission API.
- **[Multiple api workers compute `expiresAt` from their own clocks]** → small TTL skew between instances. → Mitigation: standard NTP assumption; the unique-constraint arbiter makes a clock gap a non-issue for correctness, only for exact retention.
- **[Dropping `UNIQUE (idempotency_key)` on `payroll_events` removes a defensive backstop against duplicate event rows]** → dedupe now rests solely on `idempotency_records`. → Mitigation: that is the deliberate new architecture — the `(scope, key)` unique is the authoritative arbiter, the traceability index remains, and the spec scenario requiring the drop is tested e2e.
- **[Race read (D2 step 5) could find a just-expired winner record]** → only if the winner's TTL elapsed between its commit and our read. → Mitigation: the winner inserted with `expiresAt = now + TTL` moments before, so this window is negligible; even then the code rethrows rather than inventing a response.

## Migration Plan

1. **Schema + migration:** edit `prisma/schema.prisma` (add `IdempotencyRecord`, drop the two response columns, relax the idempotency-key unique to an index), then `npx prisma migrate dev --name idempotency_records`. The generated migration contains `CREATE TABLE "idempotency_records" ...`, `ALTER TABLE "payroll_events" DROP COLUMN "response_status" DROP COLUMN "response_body"`, and the unique→index swap on `idempotency_key`.
2. **Deploy order:** app code and migration ship together (migration runs first via `prisma migrate deploy` in CI/entrypoint). No backfill by default (see Risk 1 for the optional SQL).
3. **Rollback:** restore the pre-migration DB dump (or reverse-apply: `ADD COLUMN` the response columns + re-add the unique index). Because the response columns are dropped, rollback is not a code-only toggle — a snapshot is required. App revert alone leaves old columns absent, so keep the schema snapshot with the deploy.
4. **Config rollout:** add `IDEMPOTENCY_TTL_SECONDS` and `IDEMPOTENCY_SWEEP_INTERVAL_MS` to `.env.example`, `.env.development`, `.env.test`, `.env.production`, and the docker-compose api/worker service `environment` blocks (top-level-priority pattern used in `docker-compose.override.yml`). Defaults preserve today's behavior (24-h window).
5. **Verification:** `npm run lint`, `npm test`, `npm run test:e2e` against Dockerized Postgres + Redis; manual Swagger check that the `Idempotency-Key` header is still documented on `POST /events`.

## Open Questions

- **Backfill on migration:** auto-backfill existing response columns into `idempotency_records`, or accept a cold start for pre-existing keys? — Default decision: no auto-backfill (dev-stage repo, short windows); the SQL is documented for the operator.
- **Sweep cadence configuration:** env-configurable (default 60 s) vs hardcoded. — Default decision: configurable, matching the repo's env-driven configuration pattern.
- **Scope naming convention:** string literals (`event-submission`) vs enum. — Default decision: string constants in `idempotency.constants.ts` so endpoints register without schema changes; an enum can be introduced if the set stabilizes.