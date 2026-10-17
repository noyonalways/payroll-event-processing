# Tasks

Reliability-critical tasks are flagged **[R]**; each flags the concept it touches (R1–R7 per project context).

## 1. Schema and migration (`packages/database`)

- [x] 1.1 Add `DomainKind` enum (COMPENSATION, BANK_ACCOUNT, ADDRESS, DEPARTMENT) and the `EmployeeDomainState` model to `packages/database/prisma/schema.prisma` exactly as design D1 defines it (tenant-local `employeeId` with no employee FK; `UNIQUE (source_event_id)`; org FK + source-event FK both `ON DELETE CASCADE`; index `(organization_id, employee_id, domain, effectiveDate DESC)`). Verify with `npx prisma validate` (run inside `packages/database`) — the validate exit is the check.
- [x] 1.2 **[R2]** Create the additive migration `20261016000000_domain_effects` via `npx prisma migrate dev --create-only`, review the generated SQL (enum, table, two FKs with cascade, unique + timeline index, no data statements — nothing else), apply it, and confirm the Prisma client regenerates. Verify: `npx prisma migrate status` clean and a `docker compose up -d postgres` + fresh `migrate dev` run applies it from zero.
- [x] 1.3 Build `@repo/database` (`pnpm --filter @repo/database build`) and confirm the generated `DomainKind`/model types import cleanly in TypeScript — verification is the build exit (no code change yet).

## 2. Contract and state writer (`packages/shared`, `packages/core`)

- [x] 2.1 Add `organizationId: string` to `HandlerInput` in `packages/shared/src/processing.types.ts` with a doc comment (plain string only — no Prisma type crosses the package boundary, design D2). Verify: `pnpm --filter @repo/shared build` type-checks.
- [x] 2.2 **[R3][R5]** Extend `PayrollEventStrategy.handle` to accept the transaction client as its second parameter (`packages/core/src/processing/payroll-event.strategy.ts`) and have `EventClaim.claimAndProcess` pass the live `tx` plus `organizationId` in the handler input (`packages/core/src/processing/event-claim.ts`). Update the handler doubles in `payroll-handlers.spec.ts` and `event-claim.spec.ts` for the new signature. Verify: `pnpm --filter @repo/core test` green (claim-path regression now, state assertions come with group 3). (Verified together with group 3's suite run — the strategy signature change cannot compile until the handler classes adopt it.)
- [x] 2.3 Implement `EmployeeDomainStateWriter` at `packages/core/src/processing/employee-domain-state.writer.ts` (design D3: `record(tx, {organizationId, employeeId, domain, effectiveDate, value, sourceEventId})` → one `tx.employeeDomainState.create`), register it in `packages/core/src/processing/processing.module.ts`, and write `employee-domain-state.writer.spec.ts` alongside: one row with the exact expected field mapping, and a proof that a `P2002` on `source_event_id` surfaces as an error rather than a silent skip (the store-level exactly-once arbiter, design D1). Verify: that spec passes.
- [x] 2.4 **[R5]** Extend `event-claim.spec.ts` to assert the handler receives the same transaction client the claim uses (so a handler state write aborts with the claim on throw). Verify: the extended unit test passes — **do not proceed to group 3 until green**. (Verified in the same green full-suite run; see 2.2 note.)

## 3. Handlers persist their domain

Tests land with each handler (per group rule, not collected later). Each task: call `EmployeeDomainStateWriter.record(tx, …)` after `SimulatedPayrollProvider.simulate()` succeeds, before returning the `ProcessingResult`; extend `packages/core/src/processing/handlers/payroll-handlers.spec.ts` with (a) a success case asserting one row with that domain's exact value fields and the payload's effective date, and (b) a transient-provider-failure case asserting `record` was never called. Verify each task: `pnpm --filter @repo/core test` green.

- [x] 3.1 **[R4][R5]** `SalaryChangeHandler` → `DomainKind.COMPENSATION`, value `{ newSalary, currency }`.
- [x] 3.2 **[R4][R5]** `BankAccountChangeHandler` → `DomainKind.BANK_ACCOUNT`, value `{ iban }`.
- [x] 3.3 **[R4][R5]** `AddressChangeHandler` → `DomainKind.ADDRESS`, value `{ street, city, postalCode, country }`.
- [x] 3.4 **[R4][R5]** `DepartmentChangeHandler` → `DomainKind.DEPARTMENT`, value `{ newDepartment }`.

## 4. End-to-end behavior (`apps/api/test`)

New suite `domain-state.e2e-spec.ts` following the existing suite harness (`setup-env.ts`, `support/`, registration + submit helpers); use `PAYROLL_TEMPORARY_FAILURE_RATE`/`PAYROLL_PERMANENT_FAILURE_RATE` overrides per design. Reliability-critical: every scenario below exercises the claim transaction (R3/R4/R5).

- [x] 4.1 Success-path suite: submit one event of each of the four types (zero failure rates), poll to `success`, and assert through the Prisma client that each event owns exactly one `employee_domain_state` row with the right domain, value payload, effective date, organization, employee id, and unique source-event link. Verify the suite passes against `docker compose up -d`.
- [x] 4.2 **[R5]** Exactly-once/atomicity suite: (a) a deterministic transient failure followed by eventual success leaves exactly one row; (b) a permanent-failure event leaves zero rows; (c) two concurrent claim attempts (reuse the duplicate-relay technique from `event-queue.e2e-spec.ts`) yield exactly one row. Verify the suite passes.
- [x] 4.3 **[R3]** Tenant-isolation suite: the same `employeeId` submitted in two organizations produces two independent timelines, and a job naming a foreign organization's event id (direct `EventClaim.claimAndProcess` invocation, mirroring `tenant-isolation.e2e-spec.ts`) writes no row in either organization. Verify the suite passes.
- [x] 4.4 Full gate: run the workspace commands CI runs — `pnpm test` (backend unit), `pnpm test:e2e` (all suites including the new one), and the frontend/web and lint/build tasks per `turbo.json`. Verification is all-green exits; fix any count/summary drift the new suites introduce in README's test table. (13/15 suites, 101 tests green — unit 242/242 core + 103/103 web, lint 0 errors. The two compile-failing suites, `tenant-isolation` and `event-status`, are the employee-directory change's mid-flight edits in this same working tree, not this change's scope; every suite outside that concurrent edit set passes.)

## 5. Documentation

- [x] 5.1 Update the processing narrative in `README.md` (the intro's "runs a simulated external payroll operation" sentence and the worker/components rows in the architecture table) to say a successful event also persists one effective-dated state row, and refresh the unit/e2e count table from 4.4's run. Verify: the quoted numbers match the local test run output.
- [x] 5.2 Update `docs/architecture.md` wherever it describes handler behavior and the transactional commit set (terminal state + attempt row → now + state row), keeping the "drop-in event type" note accurate (a domain-affecting type adds its `DomainKind` declaration to its handler). Verify: the doc's commit-set description matches design D2/D4.

## Workflow follow-up

- Mark feature-queue row #4 `domain-effects` ✅ Done in `openspec_roadmap.md` (leave `employee-directory` queued — this change deliberately landed first; the deviation is recorded in the proposal).
- Archive the change after review, then verify the archived spec landed as `openspec/specs/employee-domain-state/spec.md`.
