# Proposal

## Why

Integrators can only learn that a payroll event reached a terminal state by polling
`GET /events`/`GET /events/{id}` or by holding the SSE lifecycle stream open. Neither is a
dependable machine-to-machine contract: polling wastes requests and adds latency, and SSE is
browser-oriented with no delivery persistence — a disconnected consumer silently misses the
transition. With the lifecycle, recovery, and tenancy foundations done, push notification to
external systems is the first item of the integration story in the feature queue.

## What Changes

- New per-organization **webhook endpoint configuration**: an integrator registers an HTTPS
  callback URL plus a generated signing secret; endpoints are scoped to the caller's organization.
- **Transactional outbox**: a `webhook_deliveries` row is written in the SAME database
  transaction that commits a terminal event state (`success`, `failed`, `cancelled`) — closing
  the gap the realtime-status design deliberately left to this change (its D7/non-goals
  "transactional outbox … belongs to integrator-webhooks").
- **Delivery relay**: a background relay reads pending outbox rows and delivers signed webhooks —
  `POST` JSON payload with an HMAC-SHA256 signature header computed from the endpoint's secret.
- **Delivery retry semantics**: transient delivery failures (network errors, 5xx, timeouts) retry
  with exponential backoff; permanent rejections (4xx) and exhausted retries dead-letter the
  delivery, recorded with attempt trail for observability.
- Delivery intent rows are tenant-scoped and never block or delay the terminal event commit —
  a delivery failure can never roll back a processed event (same critical-path isolation the
  2s enqueue rule applies to submission).

## Capabilities

### New Capabilities
- `webhook-delivery`: Signed, at-least-once webhook delivery of terminal event states to
  per-organization endpoints — endpoint configuration, transactional outbox enqueue, signed
  delivery with retry/dead-letter semantics, and delivery attempt observability.

### Modified Capabilities
- `event-processing`: The terminal commit of the worker's claim transaction (`processing →
  success` and `processing → failed`) SHALL additionally persist a webhook delivery intent row in
  the same transaction, so no terminal transition can commit without its notification intent.

## Impact

- **DB**: new `webhook_endpoints` and `webhook_deliveries` tables (+ Prisma migration); the
  `event_attempts`/terminal-write pattern in `EventClaim` gains one insert.
- **API**: new CRUD endpoints for webhook endpoints, read endpoints for delivery status.
- **Worker**: new BullMQ-driven (or poll-driven) delivery relay alongside the payroll event
  processor; new signing utility in `@repo/core`.
- **Security**: HMAC-SHA256 request signing; secrets stored per endpoint (never logged).
- **Reliability**: extends "exactly-once processing" — the delivered business effect and its
  notification intent commit atomically; delivery itself is at-least-once with idempotent
  consumers expected to verify signatures and deduplicate on event id + status.

## Non-goals

- No UI for webhook management in this change (API-only; frontend wiring can follow).
- No delivery filtering by event type or per-endpoint event selection — every terminal state of
  the organization's events is delivered.
- No replay of historical events retroactively — only transitions committed after endpoints exist.
- No webhook payload enrichment beyond committed data (no template customization).
