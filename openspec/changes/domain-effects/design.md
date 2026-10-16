# Design: domain-effects

## Context

`EventClaim.claimAndProcess` (`packages/core/src/processing/event-claim.ts`) already runs the whole processing lifecycle in ONE interactive Prisma transaction: row lock → guarded `queued → processing` claim → payload read → `strategy.handle(...)` → terminal write + `event_attempts` row. Handlers today call `SimulatedPayrollProvider.simulate()` and return a `ProcessingResult` that is stored as JSON on the event; nothing else changes state. `HandlerInput` (`packages/shared/src/processing.types.ts`) carries identity + payload + attempt, but no transaction client and no organization id (the claim input has it, `HandlerInput` does not).

Constraints that shape the design:

- `@repo/shared` is deliberately framework-agnostic; `@repo/core` is the only place allowed to depend on `@repo/database`/`@prisma/client` (workspace boundaries are package-manager-enforced).
- `payroll_events.employee_id` is a tenant-local string, deliberately not an FK (see the model comment in `packages/database/prisma/schema.prisma`); there is no `employees` table yet (`employee-directory` is a later, still-queued feature).
- The claim transaction's guarantees — exactly-once (R5), crash-rollback (R4), row-lock serialization (R3) — are the only safe place to persist effects.

See proposal.md for motivation; see the delta spec for the behavior contract.

## Goals / Non-Goals

**Goals:**

- Handlers persist effective-dated state inside the claim transaction, with zero new failure modes: no state without `success`, no `success` without state.
- DB-level exactly-once: uniqueness on the source event makes a second row per event impossible.
- Strategy-pattern extensibility preserved (R7): handlers own their domain mapping; the writer owns insert shape.

**Non-Goals:**

- No `employees` table/FK, no read API/UI, no backfill of pre-existing `success` events, no new event types or payload changes (see proposal Non-goals).

## Decisions

### D1 — One append-only `EmployeeDomainState` timeline table, not four typed tables

**Files:** `packages/database/prisma/schema.prisma` (modified), new migration `packages/database/prisma/migrations/20261016000000_domain_effects/migration.sql`.

```prisma
enum DomainKind {
  COMPENSATION
  BANK_ACCOUNT
  ADDRESS
  DEPARTMENT
}

model EmployeeDomainState {
  id             String      @id @default(uuid())
  organizationId String      @map("organization_id")
  employeeId     String      @map("employee_id")
  domain         DomainKind
  value          Json        @db.JsonB
  effectiveDate  DateTime    @map("effective_date") @db.Date
  sourceEventId  String      @unique @map("source_event_id")
  createdAt      DateTime    @default(now()) @map("created_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  sourceEvent  PayrollEvent @relation(fields: [sourceEventId], references: [id], onDelete: Cascade)

  @@index([organizationId, employeeId, domain, effectiveDate(sort: Desc)])
  @@map("employee_domain_state")
}
```

Explicit changes: new enum `domain_kinds` { COMPENSATION, BANK_ACCOUNT, ADDRESS, DEPARTMENT }; new table `employee_domain_state` with columns `id uuid PK`, `organization_id uuid NOT NULL FK → organizations(id) ON DELETE CASCADE`, `employee_id varchar NOT NULL` (tenant-local string, mirrors `payroll_events.employee_id` — deliberately **no** FK), `domain domain_kinds NOT NULL`, `value jsonb NOT NULL`, `effective_date date NOT NULL`, `source_event_id uuid NOT NULL UNIQUE FK → payroll_events(id) ON DELETE CASCADE`, `created_at timestamptz NOT NULL DEFAULT now()`; index `(organization_id, employee_id, domain, effective_date DESC)`.

Why one table: the four domains share all metadata (tenant, employee, effective date, source event, created-at); only the applied fields differ, and each event type's payload is already validated at submission, so `value` JsonB holds exactly the per-type applied fields. `UNIQUE (source_event_id)` is the exactly-once arbiter — one row per successful event is enforceable by the store, mirroring how `idempotency_records` uses `UNIQUE (organization_id, scope, key)` (R5, R2). Rejected alternatives: **four typed tables** (4× metadata duplication, four append paths to guard, four migrations for what is one event-driven behavior); **one wide table with nullable per-domain columns** (sparse rows, no integrity gain over JsonB, uglier reads); **snapshot upsert keyed `(org, employee, domain)`** (destroys the effective-dated history the roadmap explicitly asks for, and upserting a "current" row inside the claim tx is harder to make idempotent than appending a unique row).

Unlike `event_attempts` (which inherits scope through its FK and has no `organization_id` column), state rows carry the org column: current-state reads are per-employee org-scoped scans, so the tenant discriminator belongs in the row itself.

### D2 — Transaction client passed as a `handle()` argument, keeping `@repo/shared` Prisma-free

**Files:** `packages/core/src/processing/payroll-event.strategy.ts` (modified), `packages/core/src/processing/event-claim.ts` (modified), `packages/shared/src/processing.types.ts` (modified).

The strategy contract becomes:

```ts
handle(input: HandlerInput, tx: Prisma.TransactionClient): Promise<ProcessingResult>;
```

`EventClaim` passes the interactive transaction client it already holds. Additionally `HandlerInput` gains `organizationId: string` (claim input already carries it; a plain string, no Prisma type crosses into `@repo/shared`). Rejected alternative: putting `tx` inside `HandlerInput` — that would make `@repo/shared` depend on `@prisma/client` types and break its framework-agnostic role, and the workspace boundary is enforced by the package manager. A second rejected alternative: the claim itself writes state after the handler returns — that moves per-type domain knowledge (`SALARY_CHANGE → COMPENSATION`, applied-value extraction) back into `EventClaim`, undoing the strategy pattern the handler registry exists for (R7).

Reliability: the handler writes through the *same* transaction that claims and commits (R5: state, terminal transition, attempt row commit together; R4: any throw or crash aborts everything).

### D3 — A single `EmployeeDomainStateWriter` helper owns row persistence

**Files:** new `packages/core/src/processing/employee-domain-state.writer.ts` (+Nest spec), `packages/core/src/processing/processing.module.ts` (provide + export).

One small injectable: `record(tx, { organizationId, employeeId, domain, effectiveDate, value, sourceEventId })` and nothing more — it maps nothing, decides nothing; each handler declares its own `DomainKind` and its own applied-value object. Why a helper rather than inline `tx.employeeDomainState.create` in all four handlers: one place for the insert shape, so the JsonB value contract and provenance fields can't drift between handlers; handlers stay pure strategy (payload → applied values → result). Rejected alternative: a type→domain map inside the writer — a new event type should be drop-in (R7) without touching shared code, so the domain declaration belongs in the handler.

### D4 — Handlers write state only after the simulated provider succeeds

**Files:** `packages/core/src/processing/handlers/salary-change.handler.ts`, `bank-account-change.handler.ts`, `address-change.handler.ts`, `department-change.handler.ts` (all modified).

Handler order inside the claim transaction: call `SimulatedPayrollProvider.simulate()` → on success, `writer.record(tx, ...)` → return `ProcessingResult`. A transient provider failure re-throws before any state write (tx aborts, claim rolls back, R1+R4); a permanent failure is caught by `EventClaim`'s existing permanent-failure path — no state row, commit `processing → failed` (R5). The provider call already happens inside the transaction today, so this ordering introduces no new latency class; the writer adds one INSERT on the success path. `ProcessingResult` and everything downstream of it (event `result` column, status API, frontend) are unchanged.

### D5 — Employee identity stays tenant-local; no dependency on `employee-directory`

State rows key on `(organizationId, employeeId)` strings exactly like `payroll_events`. The queued roadmap change `employee-directory` can later add a directory and optionally tighten identity via an additive migration; nothing here needs to know whether an employee record exists (reliability R3 tenancy isolation is by org column + claim-time org check, which D1 and the existing claim already provide).

## Risks / Trade-offs

- [JsonB `value` weakens DB-level typing vs four typed tables] → payload shape is validated at submission by the payload DTOs; per-type e2e assertions pin each domain's value shape; a future typed-materialization can be additive.
- [Handler now writes state while holding the FOR UPDATE row lock] → already true of the provider call today; the writer adds a single INSERT on the success path; the tx timeout (10s) and provider latency budget are unchanged.
- [`employee-directory` lands later and wants an FK from state rows] → `employee_id` staying a string is compatible; tightening identity is one additive migration over `(organization_id, employee_id)` values already present.
- [Future event type with no domain mapping would succeed without writing state] → acceptable and consistent with the delta spec (it only requires state for the four current types); a domain-affecting type adds its domain + handler declaration as part of being drop-in.

## Migration Plan

1. Add model + enum to `packages/database/prisma/schema.prisma`; create migration `20261016000000_domain_effects` (additive DDL only: enum, table, FK, unique + timeline index; no data backfill).
2. Ship code + migration together (`prisma migrate deploy` in CI/e2e already applies pending migrations). During the deploy window, rows created by new code are invisible to old code (old code never reads the table), and old code never reaches `success` without state because handlers and claim ship in the same build.
3. Rollback: revert the app build — pre-change code is correct without the table (it never touches it); dropping `employee_domain_state` afterwards is optional and safe (append-only provenance data).

## Open Questions

(none — the employee-directory ordering deviation is recorded as a proposal assumption, and every deferred item is a proposal Non-goal.)
