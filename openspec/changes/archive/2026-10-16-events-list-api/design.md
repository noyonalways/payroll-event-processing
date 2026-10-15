# Design

## Context

See `proposal.md` — Why. Constraints that shape the design:

- `payroll_events` carries tenant-leading composite indexes from the multi-tenant conversion: `(organization_id, status)`, `(organization_id, employee_id, created_at)`, and the unique `(organization_id, employee_id, sequence)`. There is **no** index that serves "newest first for the organization" without a sort step.
- The events module in `@repo/core` already owns every read path (`getEventStatus`) and the tenant scoping lives there; a list query belongs in the same module so scoping cannot diverge.
- The web app deliberately has no router or data-fetching library — it hand-rolls polling (`useEventTracker`) and persists state via `storage.ts`. Both were the workaround for this missing endpoint.
- The global `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`, which applies to query DTOs too: every accepted query parameter must be declared on the DTO or valid requests are rejected.

## Goals / Non-Goals

**Goals:** stable pagination that survives concurrent writes; filters that compose with pagination and each other; scoping enforced the same way as every other read; a light response shape; and a UI that finally trusts the server for history.

**Non-Goals:** payload/result search; retry or cancellation actions; SSE; payload emission in list rows; any change to the processing lifecycle.

## Decisions

### D1 — Keyset pagination on `(created_at, id)` behind an opaque cursor

Order is `created_at DESC, id DESC`. The cursor is a versioned payload (`{v, t, i}` — ISO creation timestamp and event id) base64url-encoded; passing a cursor continues strictly after that row. Rationale: `createdAt` is not unique (burst submissions of different employees can share a timestamp), so the id tiebreaker makes the position exact — two rows with identical timestamps cannot both be "next". The token is opaque and validated: an undecodable cursor is a `400`, because treating a corrupt cursor as "page one" would silently re-serve data a client has already seen.

**Alternative — offset/limit on row numbers:** simpler, but every insert shifts later pages, so a list being read while the org is active silently skips or repeats rows. That failure is exactly what a history view must not have.

### D2 — A query service beside the existing read, sharing the scoping path

The list query lives in the same `events` service/module in `@repo/core` as `getEventStatus`, takes the caller's organization as its required first parameter (the same convention as `createEvent`/`getEventStatus`), and projects a narrow row (never `payload`, `result`, or `attempts`). Keeping the two reads adjacent is what stops the list from quietly becoming the one query in the codebase that forgets `organization_id`. The response DTOs (`EventListItemDto`, `EventListResponseDto`) are separate from the single-event `EventStatusResponseDto` by design: a list row omits payload and attempts so that 100-row pages never carry megabytes of JSON.

### D3 — One new index, measured before it is written

The unfiltered newest-first query with a `status` filter is the shape the UI hits hardest: `WHERE organization_id = ? AND status = ? ORDER BY created_at DESC, id DESC`. The existing `(organization_id, status)` index answers the filter but forces a sort of the whole matching set for every page. This change adds a migration creating `(organization_id, status, created_at DESC, id DESC)` — but only after a captured `EXPLAIN` on the scratch database shows the planner choosing a sort for the target queries with realistic row counts, and the same plan reverting to an index scan after. **Alternative:** `(organization_id, created_at, id)` for the unfiltered browse — rejected because the status-filtered view is the common case; if EXPLAIN says otherwise at apply time, the column order follows the measurement, not this sentence.

### D4 — Filters are a validated DTO with deny-by-default semantics

`status` (enum), `eventType` (enum), `employeeId` (string), `createdAfter`/`createdBefore` (ISO strings parsed server-side), `limit` (integer, 1–100), `cursor` (opaque string) — every parameter declared, because an undeclared-but-sent parameter is a hard rejection under the existing pipe, and that is the desired over-sharing failure mode. Invalid enum/date/limit values produce a structured `400`. Date bounds are inclusive both ends and documented as such; composure with the cursor is explicit — the cursor continues the currently filtered selection rather than restarting the unfiltered query.

### D5 — The web app fetches history through the existing auth client; the tracked list dies

A new hook wraps `GET /events` over the authenticated client: it holds the current filter set and accumulated pages in component state, re-fetches page one whenever a filter changes, and appends on load-more. Row-level status polling via `GET /events/{id}` **stays** for non-terminal rows — the list endpoint is deliberately too light to serve attempts, so the detail-refresh behaviour is unchanged. The `localStorage` tracked-list persistence and the submit form's "add to tracked list" are removed: submitting re-fetches page one instead, which is what makes reloads trivially correct and makes the sign-out-isolation scenario free.

**Alternative — a data-fetching library (React Query and friends):** rejected for this change; introducing a cache-invalidation library into an app that deliberately hand-rolls its polling is a second refactor hidden inside this one, and the auth client + hook reaches the same behaviour with less surface.

### D6 — Read-only by construction

The route/service performs `findMany` and nothing else; there is no code path that can enqueue, mutate, or record. A history view that can order work around would be a correctness hazard, and the spec states the guarantee, so the design keeps the endpoint out of the modules that can write.

## Risks / Trade-offs

- **Sort cost per page before the new index exists** → the EXPLAIN gate is a task: the migration is only written once the planner shows a sort being needed on realistic data; without it the index is unused weight.
- **Chrome of pagination in an app with no router** → filters and cursors live in component state, so deep links to a filtered page are not part of this change; if deep links matter later, the URL becomes the same state and the hook is unchanged.
- **Removing localStorage tracking changes user-visible behaviour** → events a user expected to "persist" now persist *server-side*, which is stronger; the migration notice is documented in the UI change and README.
- **Cursor tokens are not permission-bound** → a cursor only ever re-flags a position; every request is still tenant-scoped and filtered server-side, so a copied cursor cannot read another organization's rows.
- **Small pages amplify request count** → default 20, max 100, enforced; the load-more UI keeps it natural.

## Migration Plan

1. Backend: DTOs + service + route behind the existing auth guard; unit specs for validation and scoping.
2. EXPLAIN gate on the scratch database → index migration only after the sort materialises.
3. e2e suite: pagination walk (no dupes, no skips), stability under concurrent submits, filter combinations, cross-tenant blindness, malformed cursor/limit as `400`.
4. Web: history page + filters + load-more; delete the localStorage path; Vitest for the hook, the auth-client integration, and the empty state.
5. Docs: README API row, architecture query-path note.
6. Gate: all suites, `turbo` tasks + cache-hit check, root/member-directory parity check.

**Rollback:** no data is written (the optional index is additive and dropping it is the only schema touch), so rollback is reverting the branch.

## Open Questions

- **Date-bound inclusivity** — inclusive at both ends is chosen here and documented in the DTO; flip to exclusive-before if a consumer needs it.
- **Admin cross-organization listing** — deliberately absent; role enforcement lands in a later roadmap change and this endpoint must not gain an escape hatch before that exists.
- **Deep links to filtered views** — deferred with the router decision.
