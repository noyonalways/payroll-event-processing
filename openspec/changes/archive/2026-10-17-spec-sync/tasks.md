# Tasks

## 1. Spec delta verification

- [x] 1.1 Re-read `packages/core/src/worker/payroll-event.processor.ts` (`recordTransientAttempt`, `onFailed` upsert) and `packages/core/src/processing/event-claim.ts` against the MODIFIED requirement in `specs/event-processing/spec.md`, line by line — verify each stated invariant (transaction placement, error-masking prohibition, upsert scope, no-rows-for-skipped-jobs) matches named code or spec test; update the delta text if any mismatch is found BEFORE archiving.

## 2. Doc remediation

- [x] 2.1 Rewrite the `context:` block of `openspec/config.yaml` to the post-Turborepo reality per design D2 (workspace layout, package roles, auth + tenancy, lifecycle with `cancelled`, updated reliability list) — verify `openspec context --json` still loads and the YAML parses; re-run `openspec status` on an existing change to confirm the planning flow is unaffected.
- [x] 2.2 Sweep `README.md` and `architecture.md` for pre-monorepo tokens (`npm workspaces`, `monorepo-lite`, bare `src/`/`frontend/` trees, "No authentication required"), fixing genuine remnants and keeping "(was frontend/)" parentheticals — deliver a short before/after list in the change notes; verify no stale token remains by grep.
- [x] 2.3 Cross-check the updated `event-processing` spec requirement names against `payroll-event.processor.spec.ts` test names — verify each new scenario has a corresponding existing (or explicitly missing, noted) test, listing gaps as findings rather than writing new tests.

## 3. Consistency pass and wrap-up

- [x] 3.1 Run `openspec validate --changes` and the full `openspec show event-processing --type spec` read-through after archive, checking the archived spec reads coherently with neighbouring requirements (lifecycle logging, worker transaction) — verify no contradictory sentence survives (e.g. another reminder of "no transient rows").
- [x] 3.2 CI parity (`pnpm lint`, unit + e2e untouched) — verify green with zero code files changed in the diff.

---

Notes (task 1.1 / 3.1 evidence):

- Delta-vs-code verification: `recordTransientAttempt` (outside-tx, best-effort,
  error-swallowing), `onFailed` exhaustion upsert (final attempt number only,
  failedReason update, create backstop), and the claim-scope no-rows path in
  `event-claim.ts` all match the MODIFIED requirement as proposed.
- Scenario/test mapping: "Every transient attempt leaves a row" →
  `records the attempt as FAILED(TEMPORARY)…`; "never masks the retry error" →
  `never masks the transient error when the audit write itself fails`;
  "Exhaustion upserts…idempotently" → `writes failed row + FAILED(TEMPORARY)
  attempt row in ONE $transaction array when exhausted`; "Skipped or stale jobs
  record nothing" → `logs skip when claimAndProcess reports the row is no
  longer queued`. All named tests exist; no gaps.
- config.yaml context rewritten to the post-Turborepo workspace (apps/api,
  apps/worker, apps/web @repo/core/database/shared; JWT tenancy + RBAC;
  lifecycle incl. CANCELLED; extended reliability list).
