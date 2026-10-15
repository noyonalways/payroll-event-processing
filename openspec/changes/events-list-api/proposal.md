# Proposal

## Why

The API can record event history but cannot show it. The only read endpoints are `GET /events/{id}` and `/health`: there is no way to list events, so nothing in the product can answer "what happened to this employee?" or "what failed today?". The web UI compensates with a browser-session workaround — `apps/web` only shows events the current user submitted in the current tab session and stores that list in `localStorage` — meaning reload-safe history, search, filtering, and any cross-user visibility are impossible. Every later feature (failure recovery, employee history, dashboards) builds on being able to list events, so this is the first entry in the roadmap's feature queue.

## What Changes

- **New read endpoint `GET /events`** — authenticated, tenant-scoped (the caller's organization only, consistent with `tenancy`), returning paginated events with: `id`, `eventType`, `employeeId`, `sequence`, `status`, `createdAt`, `updatedAt`, `processedAt`.
- **Cursor pagination** on `(createdAt, id)` — stable ordering that does not shift as new events are written, unlike offset pagination.
- **Filters** (combinable): `status` (one of the five lifecycle states), `eventType`, `employeeId`, and a `createdAfter`/`createdBefore` date range. All filters are validated; invalid values are `400`s through the existing `ErrorResponseDto` shape.
- **Explicit page shape** — `data` (the events), `nextCursor` (or `null`), and `limit`, so clients page forward without seeing internal database details.
- **A server-driven Events page in the UI** replacing the `localStorage`-only workaround: the list now comes from `GET /events`, keeps live status polling for in-flight rows, gains the filters, and survives reloads without any client-side persistence. The submit form still tracks the events it created.
- **Tenant-leading index confirmed/added** — `payroll_events` already carries `(@organization_id)`-leading composite indexes; this change verifies the query shapes they serve and adds one only if the real queries need it.

## Capabilities

### New Capabilities
- `events-query-api`: Listing and filtering organization-scoped event history — cursor pagination, combinable filters, tenant scoping, and the response contract the web UI and API consumers page through.

### Modified Capabilities
- `frontend-app`: The tracked events list becomes a server-driven, filterable history view backed by `GET /events`; the submit form keeps tracking what it created. The localStorage persistence requirement is replaced by server-side history.

## Non-goals

- **No full-text or substring search** of payloads — payload search needs document indexing and is not this change.
- **No retry/cancel actions** — that is roadmap item 2 (`event-recovery-actions`); the list only *shows* what needs recovering.
- **No employee cross-reference** — until roadmap item 3 (`employee-directory`) an `employeeId` filter matches the submitted string within the organization, which is the only meaning it currently has.
- **No changes to the worker, the processing lifecycle, or the idempotency/auth layers.** This change reads what exists.
- **No WebSocket/SSE** — realtime status is roadmap item 5.

## Impact

- **API**: one new authenticated operation, `GET /events`; documented with a `200` typed response, `401` on missing/invalid token, and `400` on invalid filter values, per the `api-documentation` capability.
- **DB**: read-only usage of `payroll_events`; at most one new composite index on `(organization_id, …)` if measured as needed — schema changes framed as a verified addendum, not assumed.
- **Code**: `@repo/core` gains a query service + response DTOs (matching the existing `events` module structure); `apps/api` exposes the route; `apps/web`'s events page, its API client and the region of `useEventTracker` that owns the tracked list are reworked; `test/` gains an e2e suite for pagination, filtering, and tenant scoping.
- **Indexes**: verified against the scratch database before the suite relies on them.
- **Docs**: README (API surface row), `docs/architecture.md` (component map gains the query path).
