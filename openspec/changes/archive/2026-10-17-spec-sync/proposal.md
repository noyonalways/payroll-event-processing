# Proposal

## Why

Two documentations of record have drifted from the shipped code. The `event-processing` spec
still says transient attempts "SHALL NOT create rows in `event_attempts`", but the worker has
recorded every attempt for some time (best-effort `FAILED(TEMPORARY)` rows outside the aborted
claim, upserted idempotently at exhaustion) — a future contributor following the spec would
delete correct code. And `openspec/config.yaml`'s project-context block still describes the
pre-monorepo world (npm workspaces, `src/`-rooted layout, `frontend/` path, "No authentication
required"), silently mis-directing every future `/opsx` planning session that loads it as
context.

## What Changes

- **Spec fix (`event-processing`)**: the attempt-recording requirement is brought in line with
  the shipped behaviour — every processing attempt that runs handler code is recorded:
  terminal attempts commit their row atomically with the terminal transition (unchanged);
  transient attempts append a `FAILED(TEMPORARY)` row best-effort OUTSIDE the aborted claim
  transaction (a recording failure is logged and swallowed, never masking the original error);
  exhaustion upserts the final attempt number's row (create as backstop, `failedReason` refresh)
  committed atomically with `queued → failed` — the one sanctioned mutation the append-only
  rule admits.
- **Doc fix (`openspec/config.yaml` context)**: rewritten to today's reality — pnpm + Turborepo
  workspace with `apps/{api,worker,web}` and `packages/{core,database,shared,...}`, JWT
  authentication + multi-tenancy (OWNER/ADMIN/MEMBER), lifecycle including `cancelled`,
  domain-effects in the claim transaction — so future `/opsx:propose` sessions plan against the
  actual architecture.
- **Doc sweep**: verify README/architecture digests have no pre-monorepo remnants beyond the
  explicit "(was frontend/)" parentheticals, and fix any found.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities
- `event-processing`: The attempt-recording requirement changes from "terminal outcomes only,
  transient rows forbidden" to "every executed attempt is recorded", documenting the
  best-effort transient row, its location outside the claim transaction, and the idempotent
  exhaustion upsert.

## Impact

- **Specs**: one MODIFIED requirement (with full scenario set) in `event-processing`.
- **Docs**: `openspec/config.yaml` context block rewrite; minor README/architecture sweep.
- **Code**: none — this change documents already-shipped behaviour; tests exist
  (`payroll-event.processor.spec.ts` covers transient recording and exhaustion upsert).

## Non-goals

- No behaviour changes anywhere — any spec/code disagreement found DURING the sweep that is not
  the two named drifts is recorded as a new finding, not fixed here.
- No backfill/migration of `event_attempts` data (rows recorded before the transient-recording
  change simply lack TEMPORARY rows; history is history).
- No re-organisation of main specs beyond the named requirement.
