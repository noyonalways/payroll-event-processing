# Design

## Context

The pipeline's current behaviour (the target of the spec fix) is implemented in
`packages/core/src/worker/payroll-event.processor.ts`: `recordTransientAttempt` appends
`FAILED(TEMPORARY)` rows outside the aborted claim transaction, best-effort (unique-violation and
DB errors are logged and swallowed so the BullMQ retry signal is never masked), and `onFailed`
commits `queued → failed` plus an upsert on `(event_id, attempt_number)` — `update` of
`failedReason` when the final transient row exists, `create` when it doesn't. The claim's
in-transaction terminal rows are in `packages/core/src/processing/event-claim.ts`. The stale doc
of record is the `context:` block of `openspec/config.yaml` (npm workspaces, `src/` tree,
`frontend/` path, "No authentication required") — loaded automatically into every future
`/opsx` planning session. README and `architecture.md` are verified monorepo-current apart from
intentional "(was frontend/)" parentheticals.

## Goals / Non-Goals

**Goals:**

- The spec paragraph and the code paragraphs read as one contract, including the subtleties that
  prompted the original design: best-effort recording, transaction placement, the single
  sanctioned mutation, and the no-rows-for-skipped-jobs invariant.
- Future planning sessions get an accurate context block without reading the codebase.

**Non-Goals:**

- Any code change; any spec edit beyond the two named items.

## Decisions

### D1 — Fix the spec toward the code; revisit only if the code is wrong

The transient-recording design is deliberate and better than the old rule (a complete attempt
trail makes exhaustion debugging possible — the `retrying` log lines alone couldn't answer "what
did attempt 2 actually say"), and the exhaustion upsert is what makes the terminal row atomic
with `queued → failed` (R5). So the spec moves; the code doesn't. The delta states the upsert's
exact scope (final attempt number only, `failedReason` only) so "append-only" remains
meaningful everywhere else. Alternative (change the code back to log-only transient observability)
rejected — it would undo a shipped capability and its tests.

### D2 — Rewrite the `config.yaml` context block as the post-Turborepo truth

New context text: pnpm + Turborepo workspace (`apps/api`, `apps/worker`, `apps/web`; `@repo/core`
business logic + composition roots, `@repo/database` Prisma + Redis, `@repo/shared` vocabulary);
NestJS 11 + React + Vite stack unchanged; JWT sessions bound to organizations with
OWNER/ADMIN/MEMBER roles (drop "No authentication required"); lifecycle
`received → queued → processing → success | failed | cancelled`; reliability list augmented with
domain-effects-in-transaction and SSE push; folder structure mapped to `packages/core/src/*`.
Deliberately stays at the level the original block was (orientation, not a feature inventory) —
queued-but-unimplemented features (webhooks, RBAC, etc.) are NOT listed, keeping the block
durable.

### D3 — Sweep protocol

`grep`-driven pass over README.md / architecture.md for the old-world tokens (`npm workspaces`,
`monorepo-lite`, bare `src/` and `frontend/` paths, "No authentication required", pre-canonical
`apps/worker` claims) — fix genuine remnants; keep "(was X/)" parentheticals. Namespace-consistency
check runs the existing spec/code consistency eyes over `event-processing` scenarios against
`payroll-event.processor.spec.ts` names as a final verification.

## Risks / Trade-offs

- [Context block drifts again] → this change sets it to durable structural facts only (D2);
  feature inventory remains in specs, which are change-managed.
- [Spec now blesses best-effort recording] → made explicit and bounded: recording failure never
  masks the retry error, and the table's audit value degrades only under co-incident DB failure.

## Migration Plan

Docs-only deploy moment: commit spec delta + config/README edits together. No code, no schema, no
env. Rollback = revert commits.

## Open Questions

None.
