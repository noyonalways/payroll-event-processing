## Why

Idempotency is a R2 reliability requirement, but today it is bespoke logic embedded in `EventsService`: the controller hand-checks the `Idempotency-Key` header, the service performs fast-path dedupe + transactional insert + unique-violation race handling, and the stored response lives on the `payroll_events` row itself. There is no reusable mechanism a second endpoint could adopt, the response store is coupled to the event table, and stored responses never expire — keys can never be reused and storage grows without bound. This change promotes idempotency to a first-class, shared layer with correct key validation, generic store-and-replay deduplication, and TTL-based retention.

## What Changes

- **New `IdempotencyModule`** (`src/common/idempotency/`), a shared module with three responsibilities:
  - **Key parsing & validation** — a `@IdempotencyKey()` parameter decorator reads the `Idempotency-Key` header and enforces its contract (required, trimmed, printable-ASCII, max length). Violations fail with structured `400` responses, generalizing and replacing the controller's inline check.
  - **Generic store-and-replay dedupe** — `IdempotencyService.execute(scope, key, op)` returns the stored response for a key when one exists (fast path), otherwise runs `op`, persists its `{ status, body }` atomically, and converts a `UNIQUE(scope, key)` race into a stored-response read. This is the existing EventsService logic generalized and reusable by any endpoint.
  - **Dedicated response store with TTL** — a new `idempotency_records` table (`scope`, `key`, `response_status`, `response_body`, `expires_at`) supplants the response columns on `payroll_events`. Records expire after `IDEMPOTENCY_TTL_SECONDS` (default 86400 = 24 h); expired records are treated as absent, and a sweep purges stale rows so storage stays bounded.
- **Refactor `POST /events` to consume the layer** — the controller uses `@IdempotencyKey()`; `EventsService` swaps its bespoke dedupe for `IdempotencyService` under an `event-submission` scope. The payroll event insert and the idempotency record write commit in the same transaction, preserving exactly-once semantics. The external API contract is unchanged.
- **Migration** — add `idempotency_records`; drop the now-redundant `response_status` / `response_body` columns from `payroll_events` (**BREAKING** — internal persistence change; no external API change).
- **Config & observability** — add `IDEMPOTENCY_TTL_SECONDS` plus Joi schema support; every idempotency decision logs structured context (`scope`, `key`, outcome: `hit`/`miss`/`expired`/`race`, plus `eventId` where available).

## Capabilities

### New Capabilities
- `idempotency`: Reusable API idempotency layer — `Idempotency-Key` parsing & validation, generic store-and-replay deduplication with atomic response persistence, and TTL-based retention with sweep cleanup.

### Modified Capabilities
- `event-submission`: Stored-response replay moves from the `payroll_events` row to the shared idempotency store, and the now-redundant `response_status`/`response_body` columns are removed. The external contract — `201` + `{ id, status: "received" }`, `400` when the header is missing/invalid, duplicates returning the exact stored response, exactly-one row per key — is unchanged.

## Non-goals

- Processing-side exactly-once guarantees — the worker's status-transition guard stays as-is; this change is the API/submission layer only (confirmed scope).
- Changing the external submission contract, response bodies, or status codes.
- Distributed locking beyond the existing PostgreSQL unique constraint and per-employee advisory locks.
- Authentication / authorization, metrics dashboards, or alerting.

## Impact

- **Code**: `src/common/idempotency/*` (new module), `events.controller.ts`, `events.service.ts`, `events.module.ts` (import of the module), `app.module.ts` (import/Joi), `prisma/schema.prisma` + a new migration.
- **Tests**: new unit specs for the decorator and `IdempotencyService` (fast path, miss-then-store, unique-violation race, TTL expiry, sweep), refactored controller/service specs, and e2e updates for any assertions on the removed columns.
- **Config**: `IDEMPOTENCY_TTL_SECONDS` (and sweep interval, if made configurable) added to `.env.*` templates, the Joi schema in `app.module.ts`, and docker-compose overrides following the existing top-level-priority pattern.
- **API / DB**: no external API change; one additive table migration plus a column-drop on `payroll_events`.
- **Docs**: Swagger/OpenAPI still documents the `Idempotency-Key` header — now via the shared decorator rather than a controller-level `@ApiHeader`.