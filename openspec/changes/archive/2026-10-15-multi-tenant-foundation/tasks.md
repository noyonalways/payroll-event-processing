# Tasks

## 1. Schema & migration

- [x] 1.1 Add `Organization`, `User`, `Membership` (with `MembershipRole`), and `RefreshToken` models, add the `organizationId` relations to `PayrollEvent` and `IdempotencyRecord`, replace the two global unique keys with tenant-qualified ones, and replace the single-column indexes with tenant-leading ones — verify `npx prisma validate` passes and `npx prisma generate` succeeds
- [x] 1.2 Write the migration that creates the four tables, seeds the legacy organization only when pre-existing rows exist, adds `organization_id` nullable → backfills → `SET NOT NULL` (no default), adds the foreign keys, swaps the unique keys, and adds the `event_attempts` → `payroll_events` foreign key — verify `prisma migrate deploy` applies it to a fresh database
- [x] 1.3 Verify the backfill path on a populated database: apply the pre-change migrations, insert a `payroll_events` row, an `idempotency_records` row and an `event_attempts` row, apply this migration, and confirm one `Legacy Tenant` organization adopts all three rows
- [x] 1.4 Verify the schema matches the migration history (`prisma migrate diff --from-url … --to-schema-datamodel … --exit-code` reports no difference) and that a second organization can insert the same `employee_id`/`sequence` and the same idempotency key while same-organization duplicates are still rejected
- [x] 1.5 Extend the schema-integrity e2e coverage (`test/recovery-schema.e2e-spec.ts` or a sibling) to assert the new unique keys, the `NOT NULL` discriminator, and the `event_attempts` foreign key — verify the assertions fail when run against a database migrated only up to the pre-change schema

## 2. Authentication module

- [x] 2.1 Implement `PasswordService` (scrypt with self-describing digests, bounded stored parameters, constant-time verification) — verify `password.service.spec.ts` covers a hash/verify round-trip, a wrong password, a malformed digest, and out-of-range recorded parameters
- [x] 2.2 Implement `TokenService` (access-token signing carrying `{ sub, org, role, type }`, refresh tokens stored as digests, single-use rotation, reuse detection revoking the whole family, idempotent revoke) — verify `token.service.spec.ts` covers issuance, rotation, reuse, expiry, and an unknown token
- [x] 2.3 Implement `AuthService` (atomic organization + user + `OWNER` registration with slug disambiguation, login with indistinguishable failures and multi-membership resolution, refresh re-validating the membership, logout, me) — verify `auth.service.spec.ts` covers each path including a duplicate email, a weak password, and an ambiguous membership
- [x] 2.4 Implement `JwtAuthGuard` with `@Public()` and `@CurrentActor()`, and register the guard as `APP_GUARD` in `AuthModule` — verify `jwt-auth.guard.spec.ts` covers public routes, a missing token, an invalid or expired token, and a refresh token presented as an access token
- [x] 2.5 Implement `AuthController` and its DTOs (`register`, `login`, `refresh`, `logout`, `me`) with class-validator rules and Swagger annotations — verify `auth.controller.spec.ts` covers routing and the public/protected split, and that the five operations appear in the OpenAPI document
- [x] 2.6 Wire `AuthModule` into `app.module.ts` with `JwtModule` configured from `AUTH_JWT_SECRET` — verify the API boots and `GET /auth/me` returns `401` without a token

## 3. Tenant-scoped data path

- [x] 3.1 Require the organization in `IdempotencyService.execute` and key all reads/writes by `(organizationId, scope, key)` — verify `idempotency.service.spec.ts` covers the existing replay/race/expiry paths plus two organizations using the same key value independently
- [x] 3.2 Scope `EventsService` by organization: tenant-qualified advisory lock key, `MAX(sequence)` per organization, `organizationId` on insert, tenant-filtered status read, org-scoped `markQueued` — verify `events.service.spec.ts` covers per-organization sequence numbering and a foreign-organization status read returning not-found
- [x] 3.3 Resolve the organization from `@CurrentActor()` in `EventsController` and document the `401` on both operations — verify `events.controller.spec.ts` passes and the OpenAPI document marks both operations as bearer-secured
- [x] 3.4 Make the producer's `jobId` tenant-qualified and carry `organizationId` in job data — verify `payroll-event-queue.service.spec.ts` asserts the job id and payload for two organizations sharing one `employeeId`
- [x] 3.5 Scope `EventClaim` by organization across the row lock, guarded claim, payload read, and terminal writes — verify `event-claim.spec.ts` covers a job naming another organization's event id applying no state change
- [x] 3.6 Carry the organization through the worker processor (pre-queue flip, claim input, exhaustion write, completion relay) and scope `relayNextPending` by organization — verify `payroll-event.processor.spec.ts` covers a relay that does not select another organization's pending event for the same employee id

## 4. Configuration & bootstrapping

- [x] 4.1 Add `AUTH_JWT_SECRET` (required, minimum 32 characters, no default), `AUTH_ACCESS_TOKEN_TTL`, and `AUTH_REFRESH_TOKEN_TTL_DAYS` to the `app.module.ts` Joi schema — verify `npx prisma validate` and `npm run build` still pass
- [x] 4.2 Add all three variables with explanatory comments to `.env.example`, `.env.development`, `.env.test`, and `.env.production`, and supply `AUTH_JWT_SECRET` in the CI e2e job (which has no `.env.test`) — verify the variable is present in every file the app reads per `NODE_ENV`
- [x] 4.3 Verify the application fails fast with a descriptive error and a non-zero exit when `AUTH_JWT_SECRET` is unset or shorter than 32 characters, and that it boots normally when the value is valid

## 5. Cross-tenant isolation (e2e)

- [x] 5.1 Add a shared e2e helper that registers an organization and returns authenticated request headers, and convert `test/event-submission.e2e-spec.ts` and `test/event-status.e2e-spec.ts` to it — verify both suites pass
- [x] 5.2 Convert `test/event-queue.e2e-spec.ts`, `test/event-queue-redis-down.e2e-spec.ts`, and `test/processing.e2e-spec.ts` to authenticated requests — verify all three suites pass
- [x] 5.3 Convert `test/idempotency-records.e2e-spec.ts`, `test/api-docs.e2e-spec.ts`, and `test/health-check.e2e-spec.ts` — verify all three pass and that `/health` still answers without a token
- [x] 5.4 Add a cross-tenant isolation e2e suite: a second organization cannot read or submit against the first's data, a foreign event id returns `404` indistinguishable from an unknown id, the same idempotency key produces independent events per organization, and the same `employeeId` gets independent sequences

## 6. Frontend authentication

- [x] 6.1 Add session storage and an auth-aware API client (attach the bearer token, refresh once transparently on `401`, clear the session when a refresh fails) — verify its vitest suite covers attaching, refresh-and-retry, and clearing on refresh failure
- [x] 6.2 Add the sign-in/registration view and gate the event views behind it — verify component tests cover successful sign-in, registration, error surfacing, and that no submission can be sent without a session
- [x] 6.3 Attach the access token to the existing submit and poll requests, and clear tracked events on sign-out — verify the submit-form and event-tracker tests pass with the token attached and that sign-out clears retained state

## 7. Integration verification & records

- [x] 7.1 Run the backend suites green (`npm run lint:check`, `npm test`, `npm run test:e2e`) and the frontend suite green (`npm --prefix frontend run test:run`)
- [x] 7.2 Smoke-test the Docker stack end to end: register an organization, submit an event, observe it reach a terminal state, then confirm a second organization sees none of it
- [x] 7.3 Update `README.md` (API surface including `/auth`, the tenancy model, the new environment variables, the legacy-tenant note, and the UI sign-in flow) and `docs/architecture.md` (tenancy boundary, claim/relay scoping, authentication flow) — verify every documented command runs as written

## Workflow follow-up

- Archive the change once review is satisfied, and verify the resulting capability specs under `openspec/specs/` reflect these deltas.
