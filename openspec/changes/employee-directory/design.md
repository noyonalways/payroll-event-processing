# Design — employee-directory

## Context

`payload.employeeId` is accepted free-form today (events.service.ts:152), stored as a
tenant-local string on `payroll_events`, and deliberately has no foreign key — the schema comment
already names an organization-owned employees directory as the later change. The multi-tenant
foundation supplies the seams this change plugs into: every route is behind `JwtAuthGuard` with
`@CurrentActor()` organization scoping, cross-org reads are shaped as `404`, and
`createTenantWithOwner` already creates the tenant plus owner in one transaction (the natural
seeding point). Cursor pagination and its strict-decode-then-`400` contract exist on
`GET /events` (events.service.ts `encode/decodeEventListCursor`). The UI composes feature views as
tabs in `App.tsx` (`history` | `dead-letter`) over an authenticated fetch client.

Constraint from the rules: decisions below name the reliability concept(s) they touch
(R1 temporary vs permanent, R2 idempotency, R5 exactly-once, R6 per-employee ordering) or
"tenancy" for tenant-isolation-only concerns.

## Files

Created:
- `packages/core/src/employees/employees.module.ts`
- `packages/core/src/employees/employees.controller.ts`
- `packages/core/src/employees/employees.service.ts`
- `packages/core/src/employees/dto/create-employee.dto.ts`
- `packages/core/src/employees/dto/update-employee.dto.ts`
- `packages/core/src/employees/dto/employee-response.dto.ts`
- `packages/core/src/employees/dto/employees-list.dto.ts`
- `apps/web/src/api/employees.ts`
- `apps/web/src/components/EmployeesView.tsx`
- `apps/web/src/lib/useEmployees.ts`
- `packages/database/prisma/migrations/<timestamp>_employee_directory/migration.sql`

Modified:
- `packages/database/prisma/schema.prisma` — new `Employee` model + `Organization.employees`
- `packages/core/src/app.module.ts` — register `EmployeesModule`
- `packages/core/src/events/events.service.ts` — directory check in `createEvent`
- `packages/core/src/events/events.service.spec.ts` and e2e fixtures — create directory employees before submitting
- `packages/core/src/auth/auth.service.ts` — seed demo employees in `createTenantWithOwner`
- `apps/web/src/App.tsx` — third view tab; `apps/web/src/components/SubmitForm.tsx` — employee picker;
  `apps/web/src/lib/types.ts` — `Employee` type; `apps/web/src/lib/scenarios.ts` — scenario→demo-employee mapping (already `EMP-DEMO-*`)

Not touched: `packages/shared` (the demo prefix constants already exist there), the queue,
processor, claim transaction, handlers, idempotency layer.

## Goals / Non-Goals

Goals: one authoritative per-org roster; submission gated on it; UI management; zero change to
ordering, queueing, or idempotency machinery.

Non-goals: as in proposal.md (no FK from events, no idempotency keys on CRUD, no hard delete,
no RBAC, no HR import, no events-filter change).

## Decisions

### D1 — Directory identity: surrogate UUID row per (organization, tenant-local number)

`Employee` PK is a UUID; the public cross-reference between events and the directory is
`employee_number` (what payloads call `employeeId`). Two orgs may hold the same number — matching
the tenancy rule for event identifiers — because every read is org-scoped first.

*Alternatives*: (a) make `payroll_events.employee_id` a FK to `employees.id` — rejected: forces
UUIDs into payloads (API break), rewrites history, and discards the deliberate tenant-local
identifier; (b) auto-create a directory row on first submission — rejected: silently legitimizes
typos, the very problem this change removes.

*Reliability*: R6 untouched — the advisory-lock key, `UNIQUE (organization_id, employee_id,
sequence)` and `org|employee` job ids keep using the string number. Tenancy: org-scoped reads.

### D2 — Schema (explicit)

```prisma
model Employee {
  id             String   @id @default(uuid())
  organizationId String   @map("organization_id")
  /// Tenant-local public identifier; matches payload `employeeId` exactly (case-sensitive).
  employeeNumber String   @map("employee_number")
  /// Null only for rows adopted from pre-directory event history (name unknown).
  name           String?
  department     String?
  active         Boolean  @default(true)
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, employeeNumber])
  @@map("employees")
}
```

- Constraint: `UNIQUE (organization_id, employee_number)` — the duplicate-create arbiter (→ 409)
  and the pagination index (its equality prefix + ascending number serves the list seek); it also
  keeps archived rows holding their number (no partial index), so numbers are never reused.
- FK `organization_id → organizations(id)` `ON DELETE CASCADE`, matching `memberships` et al.
- No additional index: directories are per-org and small; the unique index carries the common
  lookups (submission check = one PK-shaped `findUnique(org, number)`).
- `payroll_events` is unchanged — same columns, same constraints.

*Reliability*: none of R1–R6 interact with this table at runtime beyond D3's read.

### D3 — Submission gate: one existence read, before the idempotency layer

In `EventsService.createEvent`, after `payloadValidator.validate`, resolve the payload's
`employeeId` with `prisma.employee.findUnique({ organizationId_employeeNumber: … })`; missing or
`active = false` → `UnprocessableEntityException` (HTTP `422`, `ErrorResponseDto` shape via the
global filter) naming `employeeId`. Placement rationale:

- *Before* (not inside) `idempotency.execute` — R2: a `422` must not consume the
  `Idempotency-Key`; the first *valid* resubmission creates the event. (Inside the op it would
  also be uncaptured on rollback, but the race path could then serve a winner response that
  bypassed validation clarity — outside is unambiguous and one line of code.)
- The read is one indexed lookup on the submission hot path; cost is negligible and never blocks
  on the queue.
- A rejection is a business validation — R1's *permanent* class: the BullMQ machinery is never
  involved, so no retry can attempt it.

*Alternatives*: HTTP `400` (conflates payload-shape errors with referential rejections — clients
couldn't "fix by registering the employee, resend same key"); HTTP `404` (wrongs the response —
the *submitted event*, not the employee, is the addressed resource).

### D4 — CRUD service follows the established NestJS patterns exactly

`EmployeesModule` (models nothing global) registered in `AppModule`; `EmployeesController`
decorated like `EventsController` (`@ApiBearerAuth()`, per-route `@ApiOperation`/typed
`@Api*Response`s, `@CurrentActor()` in, `organizationId` as the first argument of every service
method — the same no-way-to-forget tenant seam). Create maps Prisma `P2002` on the unique key to
`ConflictException` (409) — same arbiter-as-truth pattern as idempotency and slug collisions; no
`Idempotency-Key` on CRUD (unique constraint is the dedupe, see Non-goals). Update is
`PATCH /employees/:id` (partial, `name`/`department`/`active`); an `employeeNumber` field in the
body is rejected `400` (immutable cross-reference). `DELETE` = archive (D5). Unknown ids and
other-org ids are the same `404` (existing isolation convention; narrows the probe surface).
*Reliability*: tenancy; no R1–R6 machinery on this path.

### D5 — Delete means archive

`DELETE /employees/:id` sets `active = false` (guarded `updateMany`, so a concurrent archive is a
no-op that still answers `204`, matching the idempotent-`logout` convention). History, sequences,
and `event_attempts` stay untouched; the unique constraint keeps the number reserved. Hard delete
is the alternative and is rejected by the spec: events would reference a directory hole and
`GET /events?employeeId=…` would silently orphan.

*Reliability*: preserves R5's forensic trail (an event's audit chain must remain interpretable
against the roster forever).

### D6 — Listing: keyset by employee number, strict cursor

`GET /employees` orders `employee_number ASC` and paginates by seek on the unique index's second
column: `WHERE organization_id = ? AND employee_number > <cursor.n>` (+ `id` unused as tiebreaker
because the number is unique per org). Cursor = base64url `{ v: 1, n: "<number>" }` — same
format family as the events cursor, distinct field set so a foreign (events) cursor decodes to a
shape without `n` and is rejected `400`. Filters: `active: boolean`, `search` (Prisma
`contains, mode: 'insensitive'` over number and name, AND-composed). Limits: `1–100`, default
`50`. Returning `limit + 1` rows answers `hasMore` exactly as the events list does.

*Alternatives*: (a) copy the events list's `created_at DESC, id DESC` ordering — rejected:
newest-first is right for an activity feed, wrong for a roster someone scans alphabetically;
(b) offset pagination — rejected: register-while-paging shifts rows (and the events change
established keyset as the house style). *Trade-off*: `search` performs a filtered scan within the
org's index range — fine at directory scale; add a trigram index only if that ever shows up.

### D7 — Demo employees are seeded, not exempted

Registration (`createTenantWithOwner`, same transaction — the partially-created-tenant rule
extends to a tenant whose demo submissions would 422) creates the five `EMP-DEMO-*` actives. The
migration backfills them for existing orgs with `WHERE NOT EXISTS` (idempotent re-runs), as does
a re-run for orgs missing individual suffixes.

*Alternatives*: (a) exempt `EMP-DEMO-*` from the submission check — rejected: the directory
invariant ("every accepted event references a directory employee") would carry a permanent carve-
out in code and spec; (b) drop the demo lever — rejected: it is the documented review/demo
convention across README, `.env.example`, and the UI selector. *Cost*: five honest rows per org —
visible, searchable, archivable like any employee.

*Reliability*: keeps R2's stored-response behaviour and the events-query employee filter working
for demo ids everywhere.

### D8 — Migration adopts the identifiers history already used

One migration, three statements: (1) create `employees` per D2; (2) adopt
`SELECT DISTINCT organization_id, employee_id FROM payroll_events` as active rows with `name =
NULL` (`WHERE NOT EXISTS` guard — every previously submitted number keeps working after deploy,
so the BREAKING edge only genuinely bites *new* unregistered numbers); (3) seed demo rows per
D7. Statement order (2) then (3) is irrelevant thanks to the guards.

*Alternatives*: no adoption — rejected: every existing integration id would `422` at once;
adopting as archived — rejected: submissions for them would still fail while history treats them
as real.

*Reliability*: R1-friendliness of the rollout (no deploy-time burst of "permanent" rejections
that are really process trivia); tenancy untouched (adoption is per-org by construction).

### D9 — UI: third tab, picker, no new data layer patterns

`App.tsx` view switch gains `'employees'`; `useEmployees` holds `{ rows, filters, loadMore,
refresh }` fetching through the authenticated client (same shape as `useEventHistory`, but
fetch-on-demand — no polling). `EmployeesView` renders the table, create form, per-row edit and
confirm-guarded archive (reusing the recovery action's confirm pattern). `SubmitForm`'s
free-text `employeeId` input becomes a `Select` fed by `GET /employees?active=true&limit=100`;
picking a demo scenario pre-fills that scenario's `EMP-DEMO-*` employee (mapping already exact in
`lib/scenarios.ts`); a manual pick still lets any active employee be used. `400`/`422` responses
surface through the existing error-message pathway with values preserved. Note: this change's
rewrite of the submit-form requirement also documents `DEPARTMENT_CHANGE`, which the form and
registry already support — a doc-reality alignment, not new behaviour.

## Risks / Trade-offs

- [Existing suites submit free-form ids and would fail en masse] → test fixtures are updated to
  create employees before events (task list flags this as the change's reliability-critical seam);
  production history is absorbed by D8 at deploy time, so no live flow breaks.
- [Employee archived after the UI loaded its picker] → server answers `422`; UI surfaces the
  structured message with values intact (spec'd scenario); user re-picks.
- [Rows adopted with `name = NULL`] → rendered as an em dash, editable via PATCH; Create DTO still
  requires `name`, so new entries are always named.
- [Adoption pollutes directories with one-off test/demo ids (e.g. the `Legacy Tenant`)] →
  accepted: rows are honest, searchable, archivable; NOT adopting would break live submissions.
- [`search` is a filtered index-range scan] → negligible at directory scale; D6 names the
  upgrade path (trigram/GIN) if ever needed.
- [422-without-key-consumption could surprise integrators who expect dedupe-on-error] → spec'd
  explicitly with the register-then-resubmit-same-key scenario.

## Migration Plan

Single Prisma migration (D2 + D8) applied by the standard `prisma migrate deploy` step the API
already runs before serving. Rollback: revert the app version — the pre-directory code ignores
the `employees` table entirely (read/write surfaces are all new), adopted and seeded rows are
inert history, and nothing in `payroll_events` changed. The migration itself is idempotent
&WLOG re-runnable (`WHERE NOT EXISTS` guards).

## Open Questions

None — the deferred-scope items (FK enforcement, idempotent CRUD, RBAC, HR import) are
deliberately recorded as non-goals for later changes, not unknowns.
