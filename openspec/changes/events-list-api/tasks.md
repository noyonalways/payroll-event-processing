# Tasks

## 1. Core — the list query (read path, tenant-scoped)

- [x] 1.1 Add list DTOs (`EventListItemDto`, `EventListResponseDto`) and the filter/page DTO (`status`, `eventType`, `employeeId`, `createdAfter`, `createdBefore`, `limit`, `cursor`) with class-validator rules (enums validated, ISO dates parsed, `limit` 1–100) — **write `events-list.dto.spec.ts` alongside**: valid combinations, an unknown status, a malformed date, a `limit` of 0/101, an undeclared query parameter rejected
- [x] 1.2 Implement the query method in the events service beside `getEventStatus` — required organization as the first parameter, `findMany` only (payload/result/attempts projected out), `created_at DESC, id DESC` ordering, filters composed with AND into the same WHERE, cursor decoded to a seek position and an undecodable cursor rejected as a structured 400; **extend `events.service.spec.ts`** alongside: tenant scoping (another org's rows never included even with the same employee id), cursor seek position, filter composition, and that the method issues no writes
- [x] 1.3 Register the operation in the controller with Swagger annotations (`@ApiBearerAuth`, typed 200 page response, 400/401) — verify `apps/api` compiles and the OpenAPI document gains `GET /events` with the bearer requirement and the page schema

## 2. Database — measure, then index

- [x] 2.1 Seed a realistic scratch dataset (multiple organizations, several hundred events across states) and capture `EXPLAIN (ANALYZE, FORMAT JSON)` for the target queries (unfiltered newest-first, status-filtered, employee-filtered, date-bounded) before any schema change — record whether the planner sorts and at what cost, so the index decision is measured rather than assumed
- [x] 2.2 Write ONE migration adding the composite index the measurements justify (expected `(organization_id, status, created_at DESC, id DESC)`; column order follows the measurement) — verify `EXPLAIN` now uses the index for the target queries and that `prisma migrate deploy` applies it cleanly on the scratch database and on a fresh one
- [x] 2.3 Confirm the uniquely-named existing indexes are untouched and the migration is replay-safe on a database already migrated

## 3. e2e — pagination, filters, scoping

- [x] 3.1 Add `test/.../events-list.e2e-spec.ts` (within `apps/api/test/`, using the shared auth helper): unauthenticated `401`; first page shape (`data`/`limit`/`nextCursor`), newest-first ordering; the cursor walk yields every event exactly once; a second tenant's events (including an identically-named `employeeId`) never appear
- [x] 3.2 Add e2e scenarios for filter composition with pagination (status+eventType+employee together across multiple pages), invalid filter values (`400` identifying the parameter), and a malformed cursor (`400`)
- [x] 3.3 Add the pagination stability scenario: fetch page 1, submit a new event as the same organization, fetch page 2 with the stored cursor — verify no row shifts or repeats
- [x] 3.4 Extend the api-docs e2e assertions: `GET /events` documented with the bearer requirement, the page schema, and its 400/401 responses
- [x] 3.5 Run the full e2e suite from `apps/api` — all prior suites still green plus the new one

## 4. Web — server-driven history

- [x] 4.1 Rework the events view to fetch from `GET /events` through the authenticated client: current page + filters in component state, load-more following `nextCursor`, and page-one re-fetch when a filter changes — verify the first render shows organization history without any prior submission
- [x] 4.2 Add the filter controls (status select, event-type select, employee input, created-date bounds) and verify Vitest covers filter changes re-fetching and combing with load-more
- [x] 4.3 Remove the `localStorage` tracked-list persistence and the submit-form "add to tracked list" path, keeping submit → refresh page one and the per-row detail polling — verify the suite still passes and sign-out/sign-in switching shows only the new organization's history
- [x] 4.4 Verify the production build emits no database or queue client reference from the list path

## 5. Docs

- [x] 5.1 Update `README.md`: API surface row for `GET /events`, the UI's history view replacing the localStorage note — verify every documented command runs
- [x] 5.2 Update `docs/architecture.md`: the query path in the component map, the read-model note — verify paths are real

## 6. Verification gate

- [x] 6.1 `pnpm turbo run lint typecheck test build` green from the root; unit (187+N), e2e (66+M), frontend (78+K) counts recorded — verified on the merged main commit (8d59975) in an isolated worktree: 19/19 turbo tasks green; counts: unit 208/20 suites (187+21), e2e 78/11 suites (66+12), frontend 84/13 files (78+6)
- [x] 6.2 Turbo cache sanity: second run cached; editing the events service re-runs only what consumes it
- [x] 6.3 Boundary check: the new query takes the organization as a required parameter (a schema-level requirement) and the route scrapes it from the token, not the request
- [x] 6.4 Re-run the EXPLAIN capture post-merge so the index decision is documented with its before/after plans

## Workflow follow-up

- Archive the change once review is satisfied, and verify `events-query-api` lands in `openspec/specs/` with the `frontend-app` deltas applied.
