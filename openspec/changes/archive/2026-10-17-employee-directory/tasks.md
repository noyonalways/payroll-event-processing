# Tasks — employee-directory

Tests are written alongside the code they cover (never after), per project convention. The
change's reliability-critical seam is the submission gate (touches `POST /events`; everything
else is fast-path CRUD off the queue/retry machinery) — tasks 2.3–2.5 and 3.6 flag it.

## 1. Schema and migration

- [x] 1.1 Add the `Employee` model to `packages/database/prisma/schema.prisma` per design D2 (uuid PK, `organization_id`, `employee_number`, nullable `name`, `department`, `active` default true, timestamps; `@@unique([organizationId, employeeNumber])`; cascade FK on `Organization.employees`) and run `pnpm --filter @repo/database prisma format` — verify: schema formats clean and `prisma validate` passes.
- [x] 1.2 Create migration `packages/database/prisma/migrations/<ts>_employee_directory/` with the three design-D8 statements: (a) create the `employees` table with its unique constraint and cascade FK; (b) adopt `DISTINCT (organization_id, employee_id)` from `payroll_events` as active rows with `name = NULL` guarded by `WHERE NOT EXISTS`; (c) seed the five `EMP-DEMO-{SUCCESS,RECOVER,TRANSIENT,FAILAFTER,PERMANENT}` active rows per organization, same guard. Verify: `pnpm --filter @repo/database prisma migrate dev` applies clean and re-running the inserts changes no rows; against the docker compose DB, `\d employees` shows the unique index and FK.
- [x] 1.3 Write an integration test for the migration/backfill semantics (real DB in Docker, next to the existing integration suites): create an org with `payroll_events` rows for two employee ids plus a partial demo set, then run the backfill statements — verify: adopted rows appear with `name = NULL`, missing demo rows appear active, pre-existing rows and events are byte-identical, and a second run is a no-op.

## 2. Submission gate (reliability-critical path)

- [x] 2.1 Add `@nestjs/common`-based DTO/repo plumbing if needed and the employee existence read in `EventsService.createEvent` (`packages/core/src/events/events.service.ts`): after `payloadValidator.validate`, `findUnique({ organizationId_employeeNumber })`; missing or `active = false` → `UnprocessableEntityException` naming `employeeId`, before `idempotency.execute`. Verify: unit test with mocked Prisma covering unknown id, archived id, and the pass-through path.
- [x] 2.2 Unit-test the key-preservation contract (design D3): a `422`-rejected submission leaves no `idempotency_records` row for the key, and registering the employee afterwards lets the same key create a fresh event. Verify: new cases in `events.service.spec.ts` / idempotency spec mirroring the spec's "does not consume the Idempotency-Key" scenario.
- [x] 2.3 **RELIABILITY-CRITICAL** — e2e (`test/event-submission.e2e-spec.ts` or a new `test/employee-gate.e2e-spec.ts`): submissions for an unknown employee → `422` with structured body referencing `employeeId` and no `payroll_events` row; archived employee → `422`; active directory employee → `201`; same `employeeId` registered in two orgs stays independent (each accepted, own sequence); seeded `EMP-DEMO-RECOVER` → `201`. Verify: suite passes against real Postgres + Redis in Docker.
- [x] 2.4 Update existing workflows that assumed free-form ids: e2e fixtures and unit setups now create employees before submitting (shared `createEmployee` helper in test utilities; per-org isolation kept). Verify: full backend suite `pnpm turbo run test test:e2e` green — this is the acceptance gate for the BREAKING edge.
- [x] 2.5 Log-line parity: the rejection logs carry `eventId`-absent context per convention (`organizationId`, `eventType`, `employeeId`, validation stage) consistent with the events module's structured logging. Verify: visible in the new unit/e2e test output.

## 3. Employees CRUD API

- [x] 3.1 Create `packages/core/src/employees/dto/` — `create-employee.dto.ts` (`employeeNumber`/`name` non-empty strings, optional `department`, class-validator + Swagger decorators), `update-employee.dto.ts` (`name`/`department`/`active` all optional), `employee-response.dto.ts`, `employees-list.dto.ts` (`data`/`limit`/`nextCursor`, employees list item). Verify: written files compile; DTO unit spec covers blank-field rejection and immutable-`employeeNumber` shape.
- [x] 3.2 Implement `employees.service.ts` per design D4/D5/D6: create (P2002 → `ConflictException`), list (seek on `employee_number`, base64url `{ v: 1, n }` cursor with strict decode → 400, `active`/`search` AND-composed, `take limit+1`), get/update (unknown → `NotFoundException`), archive (`updateMany` guard; idempotent `204`). Every method takes `organizationId` first. Verify: `employees.service.spec.ts` unit suite green.
- [x] 3.3 Implement `employees.controller.ts` + `employees.module.ts` (`POST /employees` 201/400/409/401, `GET /employees` 200/400/401, `GET|PATCH|DELETE /employees/:id` per spec; full Swagger metadata mirroring `EventsController`) and register the module in `packages/core/src/app.module.ts`. Verify: controller spec green; app boots (`pnpm --filter @payroll/api start:dev` reaches listen).
- [x] 3.4 e2e `test/employees.e2e-spec.ts` covering the `employee-directory` spec: create 201 then duplicate 409; invalid body 400; list order by number ascending + walk-all-pages yields each exactly once + cursor stability while registering + malformed cursor/limit 400 + search/active filters; get/patch (incl. `employeeNumber` change → 400) / archive 204 twice + history untouched; unknown id 404; **tenant isolation** (cross-org single reads/updates → 404 unchanged, list only own rows). Verify: suite green against Docker Postgres + Redis.
- [x] 3.5 Verify the OpenAPI document: `/api-docs-json` lists the five routes with bearer requirement, typed responses, and `400`/`401`/`404`/`409`; extend `test/api-docs.e2e-spec.ts` accordingly. Verify: e2e green.
- [x] 3.6 **RELIABILITY-CRITICAL adjacency check** — confirm no queue/retry/idempotency behavior changed: run the full e2e set (submission, queue, redis-down, processing/retry/exhaustion, idempotency-records, event-status, recovery). Verify: all 7 suites green, no fixture drift.

## 4. Registration seeding

- [x] 4.1 In `packages/core/src/auth/auth.service.ts` `createTenantWithOwner`, add `tx.employee.createMany` with the five demo rows (single shared constant from `@repo/shared` next to `DEMO_EMPLOYEE_PREFIX`) inside the existing transaction. Verify: `auth.service.spec.ts` asserts five rows for the created org.
- [x] 4.2 e2e addition (auth suite or `employees.e2e-spec.ts`): register a new org via `POST /auth/register` → `GET /employees?active=true` lists exactly the five `EMP-DEMO-*` entries (idempotent bank — a second register for a *different* email/org also shows five, none shared across orgs since ids are new). Verify: e2e green.

## 5. Frontend

- [x] 5.1 Add `Employee` type to `apps/web/src/lib/types.ts` and `apps/web/src/api/employees.ts` (`createEmployee`, `listEmployees`, `updateEmployee`, `archiveEmployee` through the authenticated client) with `employees.test.ts` mirroring `api/events.test.ts`. Verify: `pnpm --filter @payroll/web test` green.
- [x] 5.2 Implement `apps/web/src/lib/useEmployees.ts` (fetch-on-demand page state: rows/limit/nextCursor/refresh + `active` filter) and `apps/web/src/components/EmployeesView.tsx` (table: number, name/—, department, active badge, created; create form; per-row edit; confirm-guarded archive; structured error surfacing preserving inputs; empty state). Verify: component tests for create-appears, 409 surfacing, archive-in-place, empty state.
- [x] 5.3 Add the third view tab `'employees'` in `apps/web/src/App.tsx` (view switch, `data-testid="view-employees"`). Verify: `App.test.tsx` updated — tab renders EmployeesView under an active session only.
- [x] 5.4 Rework `apps/web/src/components/SubmitForm.tsx`: `employeeId` becomes a `Select` over `GET /employees?active=true&limit=100`; demo scenario change pre-fills its `EMP-DEMO-*` employee; `400`/`422` surface with values preserved. Verify: `SubmitForm.test.tsx` updated — picker lists directory employees (incl. demo entries), scenario pre-fill, error surfacing.
- [x] 5.5 Frontend suite + builds: `pnpm turbo run lint build test` across the workspace. Verify: all green; the app in `docker compose up` shows the Employees tab end-to-end (register employee → appears in submit picker → submit event → archive → picker no longer offers them).

## 6. Gates and roadmap

- [x] 6.1 Full CI parity locally: backend lint/unit/build, frontend lint/vitest/build, e2e against real Postgres + Redis service equivalents — zero new warnings on touched files. Verify: commands pass on the working tree before merge.
- [x] 6.2 Update `openspec_roadmap.md`: mark Feature Queue row 3 `employee-directory` ✅ Done. Verify: file diff.

## Workflow follow-up

- Merge on `main` after 6.1 is green; commit message `feat(employees): org-scoped employee directory with submission validation (employee-directory)`.
- After `/opsx:apply` completes, run `/opsx:archive` (specs sync + archive + roadmap row already done in 6.2).
- Noted for its own queued change: the `event-processing` spec-drift fix (Feature Queue #12) may also want the `DEPARTMENT_CHANGE` doc-alignment made here folded in.
