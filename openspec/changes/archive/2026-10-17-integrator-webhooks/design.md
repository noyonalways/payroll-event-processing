# Design

## Context

Terminal states commit in exactly two places today: the worker's claim transaction
(`packages/core/src/processing/event-claim.ts` — `processing → success|failed` plus the
`event_attempts` row) and the recovery cancel transaction
(`packages/core/src/events/event-recovery.service.ts` — `received|queued → cancelled`).
`realtime-status` deliberately shipped Redis pub/sub SSE with no delivery guarantees and left the
transactional outbox to this change. BullMQ, the shared Prisma client (`@repo/database`), and the
worker app (`apps/worker`) already exist; the stack is the pnpm Turborepo workspace with
`@repo/core` hosting both composition roots (API in `packages/core/src/app.module.ts`, worker in
`packages/core/src/worker/worker.module.ts`).

## Goals / Non-Goals

**Goals:**

- A terminal transition commits with its notification intent or not at all (outbox).
- Delivery is at-least-once, signed (HMAC-SHA256), with transient/permanent classification,
  bounded exponential backoff, and a queryable attempt trail.
- Delivery can never block, fail, or roll back the payroll event critical path.

**Non-Goals:**

- Webhook management UI (API-only this change).
- Per-event-type delivery filters, payload templates, manual dead-letter replay, and retroactive
  delivery of events committed before an endpoint was registered.

## Decisions

### D1 — DB-scheduler relay, not BullMQ, drives delivery

The relay is a poller in the worker app over `webhook_deliveries` (`status = 'PENDING' AND
next_attempt_at <= now()`, claimed with `SELECT … FOR UPDATE SKIP LOCKED`, bounded batch).
Enqueueing BullMQ jobs from the claim transaction is impossible, and enqueueing after commit
re-introduces the Redis-down gap the submission path already handles best-effort — a missed
enqueue would strand a committed intent. Polling the outbox keeps delivery correct with Redis
down (only latency-dependent), and terminal-event volume doesn't need BullMQ's throughput.

*Rationale traceability:* reliability concept 2/3 analog — the critical path never depends on
Redis for correctness; concurrency concept 3 — `SKIP LOCKED` makes relay replicas safe.
Alternative rejected: BullMQ delayed jobs keyed by delivery id (needs post-commit enqueue +
sweep anyway; two code paths for one row).

### D2 — New tables (Prisma migration in `packages/database/prisma/migrations/`)

- `webhook_endpoints`: `id` (uuid pk), `organization_id` (FK → organizations), `label` (text),
  `url` (text, https-validated at DTO + service layer), `secret` (text), `active` (boolean,
  default true), `created_at`, `updated_at`. Constraint: `UNIQUE (organization_id, label)`;
  index on `(organization_id, active)` for the claim-transaction lookup.
- `webhook_deliveries`: `id` (uuid pk), `organization_id` (FK), `webhook_endpoint_id` (FK,
  ON DELETE: no cascade — see D5), `event_id` (uuid), `terminal_status` (enum `SUCCESS`,
  `FAILED`, `CANCELLED`), `payload` (jsonb, pre-rendered snapshot), `url` (text, denormalized
  from the endpoint at creation so delivery history survives endpoint deletion), `status` (enum
  `PENDING`, `DELIVERED`, `DEAD_LETTERED`), `attempts` (int, default 0), `next_attempt_at`
  (timestamptz), `delivered_at` (timestamptz, null), `dead_letter_reason` (text, null),
  `created_at`, `updated_at`. Index on `(status, next_attempt_at)` — the relay's scan; index on
  `(organization_id, created_at DESC)` — the read API. No unique constraint across events: an
  event that is retried from `failed` and fails again commits a second, distinct `failed`
  notification.
- `webhook_delivery_attempts`: append-only, mirrors `event_attempts` discipline (reliability
  concept 5 — audit immutability): `id`, `delivery_id` (FK), `attempt_number` (int),
  `outcome` (enum `DELIVERED`, `FAILED`), `response_status` (int, null), `error` (text, null),
  `created_at`. Never updated or deleted after creation.

### D3 — One outbox writer shared by both terminal-commit sites

`packages/core/src/webhooks/webhook-outbox.writer.ts` (new `packages/core/src/webhooks/`
module, exported through the core index) receives the ACTIVE transaction client and, inside the
existing tx, finds active endpoints for the organization and bulk-inserts one PENDING delivery
per endpoint with a pre-rendered payload snapshot (eventId, organizationId, employeeId,
eventType, sequence, terminalStatus, result or failedReason, occurredAt = the committed terminal
timestamp). Both `event-claim.ts` (success + permanent-failure paths) and
`event-recovery.service.ts` (cancel path) call it. Endpoints are read inside the tx so a newly
registered endpoint never misses a transition mid-commit. Payload is rendered once and stored:
later endpoint or result mutations don't rewrite history (outbox pattern semantics).

### D4 — Signing and request shape

Body: JSON `{ eventId, organizationId, employeeId, eventType, sequence, status, result,
occurredAt, deliveryId }` serialized once into the outbox row. Headers: `Content-Type:
application/json`, `X-Payroll-Signature: sha256=<hex hmac-sha256(raw body, secret)>`,
`X-Payroll-Delivery` (delivery id), `X-Payroll-Event` (event id), `X-Payroll-Timestamp`
(ISO-8601). HMAC is computed over the exact transmitted bytes (sign-then-send on a fixed
buffer) to avoid serialization drift. Secret is 32 random bytes, base64-encoded; it is stored
recoverable (required to sign every future delivery), shown once at creation, never logged.
The signing helper lives in `packages/core/src/webhooks/webhook-signer.ts`; signature VERIFICATION
is left to consumers (we publish the algorithm in the API docs Swagger description).

### D5 — Endpoint lifecycle and its effect on pending deliveries

`DELETE /webhook-endpoints/:id` hard-deletes the endpoint; its PENDING deliveries are first
marked `DEAD_LETTERED` with reason `endpoint_removed` in one transaction (nothing left dangling:
the relay joins the endpoint row for the current secret only when the delivery is still active —
after deletion no secret exists, so undeliverable is the only truthful state). The denormalized
`url`/payload preserve history for the read API. `PATCH` can flip `active`: deactivating an
endpoint stops FUTURE intents immediately (the writer only selects active endpoints) and lets
pending rows drain once reactivated — pending rows of a deactivated endpoint are left as-is.
Alternative rejected: soft-delete columns (more state paths, no benefit given D5).

### D6 — Delivery result classification, backoff, and request execution

HTTP is executed with Node 20 `fetch` behind a thin injectable client
(`webhook-http.client.ts`) for testability. Classification: `2xx` inside a 10 s timeout ⇒
`DELIVERED` (set `delivered_at`, `next_attempt_at = null`); `4xx` ⇒ permanent ⇒ `DEAD_LETTERED`
(`dead_letter_reason = 'endpoint_rejected'`); network error/timeout/`5xx` ⇒ transient ⇒ increment
`attempts`, append a FAILED attempt row, set `backoff next_attempt_at = now() +
base * 2^(attempts-1)` (base 30 s, cap 8 attempts) and return the row to PENDING. When `attempts`
reaches the cap, mark `DEAD_LETTERED` (`'retries_exhausted'`). Relay loop config from the
existing config module (`packages/core/src/config`): `WEBHOOK_RELAY_INTERVAL_MS` (default 5000),
`WEBHOOK_RELAY_BATCH_SIZE` (default 10), `WEBHOOK_RELAY_MAX_ATTEMPTS` (default 8),
`WEBHOOK_DELIVERY_TIMEOUT_MS` (default 10000). Classification mirrors reliability concept 1
(temporary vs permanent) at the delivery layer; each attempt is audited (concept 5).

### D7 — Relay placement and concurrency

Registered in the worker composition root `packages/core/src/worker/worker.module.ts` as a
`webhook-relay.service.ts` interval service (mirrors heartbeat.service.ts styling); the API app
does NOT relay (single background-driver principle, like the payroll processor). Multiple worker
replicas are safe via `SKIP LOCKED`; occasional double-delivery after a crash between successful
POST and acknowledgement is accepted and disclosed as at-least-once (consumer dedupes on
`eventId` + `status` carried in the signature-verified body — spec-level contract).

## Risks / Trade-offs

- [Crash window between POST and `DELIVERED` write ⇒ duplicate delivery] → accepted
  at-least-once; dedupe contract (eventId + status) documented; attempt rows make redelivery
  visible.
- [Endpoint outage ties up relay batches] → per-request 10 s timeout, bounded batch size, and
  backoff remove a failing endpoint from the due set quickly.
- [Secrets stored recoverable] → required to sign; mitigations: secret only in create response,
  never logged (logger denylist convention), https-only URLs.
- [Polling adds up to one interval of latency] → acceptable for webhooks (default 5 s); SSE/REST
  remain the low-latency paths.

## Migration Plan

1. Prisma migration adds the three tables (purely additive; no existing table touched).
2. Deploy API (webhook endpoints CRUD + delivery read APIs) and worker (outbox writer call sites
   + relay) in the same release — the writer no-ops when an organization has no endpoints, so
   pre-registration tenants see zero behaviour change.
3. Rollback: disable relay via `WEBHOOK_RELAY_ENABLED=false`; tables are inert. Reverse migration
   drops only webhook tables.

## Open Questions

None — deferred details (exact retry cap tuning, payload field naming polish) do not change the
approach or task breakdown.
