# Proposal

## Why

The service currently has no notion of *whose* payroll data it holds. Every event row is globally visible: any caller who knows or guesses an event id can read it, employee numbers share one global namespace, and idempotency keys chosen by one client can collide with another's. That was acceptable for a single-tenant assessment deliverable, but it makes the service unusable as a product — a payroll service that cannot answer "which company does this row belong to?" cannot be sold to more than one customer, and cannot safely store real employee data.

This change introduces the two foundations that answer that question: authenticated identity, and an organization as the boundary every read and write is scoped by.

## What Changes

- **Tenant and identity model** — new `organizations`, `users`, `memberships`, and `refresh_tokens` tables. A user is a person (global identity); a membership binds them to one organization with a role (`OWNER` / `ADMIN` / `MEMBER`).
- **Tenant discriminator on tenant-owned data** — `payroll_events` and `idempotency_records` gain a required `organization_id` (FK, `NOT NULL`, no default so tenancy can never be implicit).
- **Tenant-qualified unique keys** — `UNIQUE (employee_id, sequence)` becomes `UNIQUE (organization_id, employee_id, sequence)`; `UNIQUE (scope, key)` becomes `UNIQUE (organization_id, scope, key)`. **BREAKING** for anything relying on the old global uniqueness, including the idempotency contract: a client-chosen key now dedupes *within its organization*.
- **Authentication** — `POST /auth/register` (creates a new organization with the caller as `OWNER`), `POST /auth/login`, `POST /auth/refresh` (single-use rotation with reuse detection), `POST /auth/logout`, `GET /auth/me`. Access tokens are short-lived signed JWTs carrying `{ sub, org, role }`; refresh tokens are opaque, hashed at rest, and revocable.
- **Deny-by-default authorization** — a global guard authenticates every route. `POST /events` and `GET /events/{id}` therefore now **require** `Authorization: Bearer <accessToken>` and return `401` without one. Only `/health`, the `/auth/*` entry points, and the API docs are `@Public()`.
- **Tenant-scoped data path** — submission, status reads, queue job identity, the transactional claim, and the FIFO relay are all scoped by the caller's organization. A cross-organization read is reported as `404`, identical to an unknown id.
- **Tenant-local employee identifiers** — `employeeId` remains a string supplied in the payload, now interpreted within the caller's organization; two organizations may use the same employee number without collision.
- **Queue isolation** — the per-employee FIFO job id becomes `<organizationId>:<employeeId>`, and job data carries the organization so a worker cannot claim or relay a foreign row.
- **Required signing key** — `AUTH_JWT_SECRET` (min 32 chars, no default) is validated at boot, so the application cannot start with an empty or well-known token signing key.
- **Demo UI stays functional** — the frontend gains a minimal authentication step and sends the bearer token, so it can still submit and observe events (see `frontend-app` delta).
- **Migration with backfill** — existing rows are adopted by a single deterministic legacy organization, created only when there is pre-existing data to adopt.

## Capabilities

### New Capabilities
- `authentication`: Identity and sessions — registration that creates an organization, credential verification, access/refresh token issuance with rotation and reuse detection, sign-out, and the deny-by-default guard that resolves a verified caller for every protected request.
- `tenancy`: Organizations and memberships as the data boundary — every tenant-owned row carries an organization, every tenant-scoped operation is filtered by the caller's organization, and cross-organization access is indistinguishable from absence.

### Modified Capabilities
- `event-submission`: `POST /events` now requires authentication and creates the event inside the caller's organization; `Idempotency-Key` deduplication is scoped to that organization.
- `event-status-api`: `GET /events/{id}` now requires authentication and only returns events belonging to the caller's organization; a foreign id is reported as `404`.
- `idempotency`: Deduplication identity becomes `(organization, scope, key)`; the layer's entry point requires the organization, and a client-chosen key can no longer replay another organization's stored response.
- `event-queue`: Job identity becomes tenant-qualified (`<organizationId>:<employeeId>`), job data carries the organization, and the completion-driven relay selects the next pending event within the same organization.
- `event-processing`: The transactional claim, terminal writes, and attempt audit trail are scoped by the event's organization.
- `app-bootstrap`: Startup now additionally requires `AUTH_JWT_SECRET` (minimum 32 characters) and fails fast without it.
- `api-documentation`: The OpenAPI document describes the authentication endpoints and marks protected operations as requiring a bearer token.
- `health-check`: `GET /health` is explicitly reachable without credentials, even though authentication is now the default for every route.
- `frontend-app`: The demo UI authenticates before submitting, attaches the access token to API calls, and surfaces sign-out; existing submit/list/detail behavior is preserved.

## Non-goals

- **Employee directory** — `employeeId` stays a tenant-local string. Validating that an employee exists, and storing an organization-owned roster, is a separate change; this one only guarantees the identifier is interpreted per organization.
- **Roles beyond membership** — a role is recorded and carried in the token, but no endpoint yet requires a specific role. Permission enforcement and role management are follow-ups.
- **Joining an existing organization** — there is no invitation or membership-management flow; registration always creates a new organization.
- **Enterprise identity** — no SSO/SAML, MFA, or password reset flows.
- **Database-level row security** — isolation is enforced in the application layer; PostgreSQL RLS is a deliberate hardening step, not part of this change.
- **User-management UI** — the frontend gains only what is needed to authenticate and keep working; no member administration screens.
- **Refresh-token retention sweep** — expired refresh rows are revocable but not yet garbage-collected on a schedule.

## Impact

- **DB / schema**: four new tables (`organizations`, `users`, `memberships`, `refresh_tokens`); `organization_id` added to `payroll_events` and `idempotency_records`; two unique keys replaced with tenant-qualified equivalents; tenant-leading indexes replace single-column ones; a real foreign key added from `event_attempts.event_id` to `payroll_events.id`. One migration, with a conditional legacy-tenant backfill.
- **API**: `POST /events` and `GET /events/{id}` become authenticated (401 without a token) and organization-scoped. Five new `/auth/*` operations. `GET /health` remains public. Error shape is unchanged, so clients keep parsing `ErrorResponseDto`.
- **Code**: new `src/auth/` module (service, token service, password service, guard, decorators, DTOs); `events` service/controller/DTO wiring; `common/idempotency` gains a required organization argument; `queue` producer and `apps/worker` processor and claim carry the organization; `app.module.ts` and `apps/worker` configuration; middleware ordering for the global guard.
- **Config**: `AUTH_JWT_SECRET` (required), `AUTH_ACCESS_TOKEN_TTL`, `AUTH_REFRESH_TOKEN_TTL_DAYS` added to `.env.example`, the stage env files, `docker-compose` environment, and the CI e2e job (which has no `.env.test` and must supply the required key).
- **Dependencies**: `@nestjs/jwt` (adds `jsonwebtoken`). Password hashing uses Node's built-in `scrypt`, deliberately avoiding a native module in the Alpine images.
- **Tests**: unit specs for the auth services and guard; every existing e2e suite must authenticate, so a shared authenticated-request helper is introduced; new isolation tests asserting that one organization cannot read or submit against another's data.
- **Docs**: README (auth + tenancy sections, new env vars, updated API table), `docs/architecture.md`, and the OpenSpec capability specs updated at archive time.
