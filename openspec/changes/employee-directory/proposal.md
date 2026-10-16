# Proposal: employee-directory

## Why

Event submission currently accepts any free-form `employeeId` string, so a typo silently starts a
fresh per-employee sequence for a person who does not exist and there is no way to browse,
correct, or wind down the set of employees an organization actually has. The `payroll_events`
schema comment already anticipated this — *"An organization-owned `employees` directory is a
later change"* — and the next roadmap change (`domain-effects`) needs a real employee to attach
its effective-dated state to.

## What Changes

- New `Employee` model (`employees` table): organization-scoped, with a tenant-local
  `employee_number` that is unique within the organization — the same identifier events carry as
  `payload.employeeId`. Per-organization ownership keeps the existing rule that two organizations
  may use the same employee number independently.
- CRUD API under `/employees` (authenticated, tenant-scoped like every endpoint): create, page
  through (keyset pagination + `search` / `active` filters), read, update (`name`,
  `department`, `active`), and archive. `employeeNumber` is immutable once created — it is the
  stable cross-reference between events and the directory. Delete is a soft archive
  (`active = false`): event history keeps its meaning and employee numbers stay reserved.
- **BREAKING**: `POST /events` now validates `payload.employeeId` against the caller's
  organization's directory — only *active* employees accept events. An unknown or archived
  employee is rejected with HTTP `422` before the idempotency layer runs (the same
  temporary/permanent-failure split as validation errors: a business rejection, never retried).
- The legacy free-form world is absorbed, not broken silently: the migration adopts every
  employee id already present in `payroll_events` (per organization) as a directory row, so
  histories keep submitting; the five `EMP-DEMO-*` scenario employees are seeded for every
  organization (migration for existing orgs, registration for new ones) so the documented demo
  lever and the UI scenario selector keep working unchanged.
- UI: a third workspace view, *Employees* — directory-backed list with create, edit, and archive —
  and the submit form's employee field becomes a picker over active directory employees instead
  of a free-text guess.

## Capabilities

### New Capabilities

- `employee-directory` — the organization's employee roster: directory ownership/tenancy rules,
  CRUD + archive behavior, pagination/search, demo-employee seeding, and OpenAPI documentation.

### Modified Capabilities

- `event-submission` — payload validation gains a directory-reference rule for `employeeId`
  (MODIFIED "Payloads are validated per event type").
- `frontend-app` — the submit form's employee field is directory-backed (MODIFIED "The UI can
  submit each supported event type"); a new Employees view is added.

## Impact

- `packages/database`: `Employee` model in `schema.prisma` + one migration (table, indexes,
  backfill of observed employee ids and demo employees).
- `packages/core`: new `employees/` module (controller, service, DTOs, Swagger) composed in
  `AppModule`; `EventsService.createEvent` gains the directory existence check before the
  idempotency layer; `AuthService.createTenantWithOwner` seeds the demo employees in the
  registration transaction.
- `apps/web`: employees API client, `EmployeesView` component, `SubmitForm` employee picker,
  third tab in the view switch.
- `payroll_events` is untouched — `employee_id` stays a tenant-local string, per-employee
  ordering (R6), the tenant-qualified queue ids, and the idempotency arbiter are unaffected. The
  new fast-path CRUD touches no queue or retry machinery (R1–R5); the one submission-path change
  is a single indexed existence read that can only produce a permanent business rejection (R1).
- Test surface: existing e2e fixtures submit free-form ids and must create directory employees
  first; new unit, e2e (CRUD + isolation + 422), and Vitest coverage for the UI.

## Non-goals

- No foreign key from `payroll_events.employee_id` to `employees` — employees stay tenant-local
  cross-references by number; historic rows are never rewritten.
- No idempotency keys on employees CRUD — the `(organization_id, employee_number)` unique
  constraint already arbitrates duplicate creates as `409`.
- No hard delete and no reuse of archived employee numbers — history must stay interpretable.
- No RBAC on the directory (uses existing role tokens; role enforcement is its own roadmap item).
- No bulk import from external HR providers (the provider adapter change may revisit this).
- No change to the `GET /events` employeeId filter — it still matches payload ids as stored.
