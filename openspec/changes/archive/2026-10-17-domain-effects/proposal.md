# Proposal: domain-effects

## Why

Today the processing pipeline is fully simulated: handlers call the simulated external provider and store a `ProcessingResult` on the event, but no business state ever changes — an organization that submits a `SALARY_CHANGE` and sees `success` has *acknowledged* a new salary nowhere outside the JSON blob on that one event. This is the "real business effects" step of the feature queue (item 4): processing should produce durable, effective-dated employee state that survives the event and can be reasoned about per employee.

## What Changes

- Handlers persist the applied change as **effective-dated employee state** — compensation (salary + currency), bank account, address, department — instead of only acknowledging it in the event result.
- State writes happen **inside the existing claim transaction** (the same `SELECT … FOR UPDATE` + guarded `queued → processing` transaction that commits the terminal write): handler success, domain-state row, terminal `processing → success`, and the `event_attempts` row all commit atomically; any transient failure or crash rolls the state write back with everything else, preserving exactly-once semantics (reliability R5, R4).
- The handler strategy contract gains the Prisma transaction client, so handlers can write state themselves — the registry/strategy pattern (R7) is unchanged.
- New `employee_domain_state` append-only timeline table: one row per successful event, carrying domain, applied values, effective date, tenant scope, and a unique link back to the source event.
- No new HTTP endpoints, no new event types, no payload changes — the externally observable API surface is identical.

## Capabilities

### New Capabilities

- `employee-domain-state`: Effective-dated employee state produced by processing — the state model (domains, timeline, provenance), the requirement that a successful event persists exactly one state row in the claim transaction, and tenant isolation of that state.

### Modified Capabilities

(none — every existing `event-processing` requirement still holds; handlers still run the simulated operation and return a typed result, the claim transaction keeps its lock/claim/terminal-commit shape. Persisting state is new behavior owned by the new capability.)

## Impact

- **Schema** (`packages/database/prisma/schema.prisma`): new `EmployeeDomainState` model + `DomainKind` enum; additive migration in `packages/database/prisma/migrations/`.
- **`@repo/shared`**: `HandlerInput` gains the transaction client (internal contract change for strategy implementers).
- **`@repo/core`**: `event-claim.ts` passes the tx into `strategy.handle`; the four handlers in `processing/handlers/` write state (via a small shared writer); unit tests (`payroll-handlers.spec.ts`, `event-claim.spec.ts`) extended.
- **e2e** (`apps/api/test/`): assertions that a successful event leaves exactly one state row, retried transients never double-write, permanent failures/crash points leave none, and cross-organization events write nothing.
- **Assumption (recorded)**: the roadmap note says `employee-directory` (feature queue #3) should land before this change. It is still queued with no artifacts, and this change is being proposed first — deliberately, because no employee identification surface is required to attach business effects: state is keyed by the same tenant-local `(organization_id, employee_id)` string pair `payroll_events` already uses, with no employee FK. Should `employee-directory` land later it can tighten identity without reworking this timeline.
- **API consumers**: none — response shapes, status endpoints, and the frontend are untouched.

## Non-goals

- No employee directory/CRUD, no employee record creation, and no FK from state rows to a future `employees` table (that is feature-queue item 3's change).
- No read API or UI for employee state — this change only establishes the write path; browsing state comes later.
- No backfill of state for events that reached `success` before this change — their effect remains represented by the stored `result` only.
- No new event types, payload shapes, or validation rules; the simulated provider and its failure-rate env vars stay as the external-call stand-in (real provider integration is feature-queue item 9).
