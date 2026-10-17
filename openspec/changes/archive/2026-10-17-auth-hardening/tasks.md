# Tasks

## 1. Schema and lockout

- [x] 1.1 Migration: add `failed_login_count`/`locked_until` to `users` and create `password_reset_tokens` (hash-unique, per design D2) in the Prisma schema; generate client — verify migration applies and types compile.
- [x] 1.2 Implement lockout in the login path of `packages/core/src/auth/auth.service.ts` (increment-on-failure, threshold lock, `429` + `Retry-After` for locked accounts, clear-on-success/expiry, per design D1) — unit-test: threshold locks, correct-password-during-lock rejected, counter cleared on success, unknown-email responses never use lock semantics, existing login specs still green.

## 2. Password reset

- [x] 2.1 Implement `POST /auth/forgot-password` and `POST /auth/reset-password` in the auth module (token issuance with hashed storage and prior-token invalidation; guarded single-use acceptance; transactional digest update + family-wide refresh revocation + lockout clear, per design D2) with DTOs and Swagger annotations — unit-test token lifecycle; e2e in `test/auth-reset.e2e-spec.ts`: identical forgot-password responses for known/unknown emails (status AND body), happy-path reset then refresh-family dead, token reuse rejected, expired token rejected, weak password rejected.

## 3. Rate limiting

- [x] 3.1 Add `@nestjs/throttler` globally (design D3): strict `@Throttle` on `/auth/login|register|forgot-password|reset-password` and `/invitations/accept` if present, generous default elsewhere, skip on `/health` and `/metrics`-class surfaces, `TRUST_PROXY` setting — e2e `test/throttling.e2e-spec.ts`: over-limit login receives `429` before password processing (assertable via fast response + no lockout side effects), normal multi-request flows unaffected, health/metrics never throttled. Verify all existing e2e suites keep passing under the default limits (raise test-env limits if they collide).

## 4. Retention sweep

- [x] 4.1 Implement `auth-sweep.service.ts` in the worker (interval `AUTH_SWEEP_INTERVAL_MS`, two bounded deleteMany per design D4, structured logging of swept counts, try/catch next-tick retry) — unit-test the WHERE-clause predicates live against a test DB: expired/revoked-old deleted, unexpired/unrevoked and recently-revoked retained, sweep failure isolated; register in `worker.module.ts` and verify `docker compose` worker boot log shows the schedule.

## 5. Docs and CI

- [x] 5.1 Update `apps/api/.env.example` with all new vars (`AUTH_LOCKOUT_*`, `AUTH_THROTTLE_*`, `DEFAULT_THROTTLE_*`, `AUTH_SWEEP_*`, `AUTH_TOKEN_RETENTION_DAYS`, `TRUST_PROXY`), Swagger error responses (429) on affected routes, and the README auth-hardening section — verify `/api-docs` renders the routes and env docs list is complete.
- [x] 5.2 CI parity: `pnpm lint`, backend unit + e2e, frontend untouched — verify green, including prior auth suites (registration, login, refresh, logout) unchanged in expectations.
