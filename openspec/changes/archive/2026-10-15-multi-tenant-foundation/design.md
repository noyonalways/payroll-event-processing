# Design

## Context

See `proposal.md` — Why for motivation. The constraints that shape this design:

- **The codebase is already async-first and Postgres-authoritative.** Submission persists then enqueues; a separate worker claims rows transactionally under a row lock. Tenancy has to reach the *worker* too, not just the HTTP layer, or a job could process a row its tenant does not own.
- **Existing deployments already hold rows.** `payroll_events` and `idempotency_records` exist without an owner, so the schema change must be applicable to a populated database, not just a fresh one.
- **Two runtime images, both `node:20-alpine`.** A native module for password hashing means either a build toolchain in the image or a per-platform prebuilt gamble.
- **`Idempotency-Key` and `employeeId` are both client-chosen values.** They are the two places where "unique" was globally true and must become "unique per organization".
- **Tests are the main consumer of the API.** Seven e2e suites boot the app in-process and call it over HTTP; making endpoints authenticated touches every one of them.

## Goals / Non-Goals

**Goals:**
- One obvious way to answer "which organization does this row belong to?", enforced on every tenant-owned read and write.
- A tenant boundary that a caller cannot widen by editing the request: the organization is only ever read from a signed token.
- Isolation that is *observable in tests*: a second organization is created in the isolation specs and attempts real cross-tenant access.
- A migration that a populated database can take, with a clear owner for pre-existing rows.
- The demo UI keeps working; no endpoint is left unusable by the change.

**Non-Goals:**
- Database-level row security (RLS). Isolation is application-enforced in this change.
- Employee directory / validating that an employee exists.
- Enforcing roles on endpoints, invitations, membership administration, SSO/MFA.
- A refresh-token retention sweep.

## Decisions

### D1 — Shared schema with an `organization_id` discriminator

One database, one migration history, an `organization_id` column on every tenant-owned table. **Alternatives:** *schema-per-tenant* (a `CREATE SCHEMA` per customer, search_path switching) and *database-per-tenant*. Both give stronger isolation, but they multiply migration work by the tenant count, complicate connection pooling, and would have required rewriting the worker's cross-row relay and the shared `idempotency_records` store. At this stage the discriminator column is the proportionate choice; the escape hatch is that all access already flows through tenant-scoped queries, so a future move to schema-per-tenant would not change the application's shape as much as it would today.

### D2 — The organization is a component of the idempotency key

`UNIQUE (scope, key)` becomes `UNIQUE (organization_id, scope, key)`, and `execute()` takes the organization as its first argument. This is not only a deduplication concern: with a global key space, two organizations that happened to choose the same key value would collide, and the second caller would be served the **first organization's stored response body** — a data leak, not merely a spurious duplicate. Making the organization a required parameter (rather than, say, prefixing the scope string at the call site) means a future endpoint cannot adopt the layer and forget the tenant.

**Alternatives:** embedding the organization in the `scope` string (no schema change, but invisible to the database and easy to forget); keeping the key global and accepting collisions (rejected — it leaks response bodies).

### D3 — Application-layer enforcement via a required tenant argument

Every tenant-scoped method takes the organization explicitly, and the organization comes from the verified token. **Alternatives considered:** a Prisma client extension that injects the filter automatically (elegant, but it cannot cover the raw `SELECT … FOR UPDATE` and `pg_advisory_xact_lock` statements this codebase relies on, so the most safety-critical queries would still be manual — and a partial guarantee is worse than an explicit one); `AsyncLocalStorage` request context (implicit, harder to test, and invisible at the call site); PostgreSQL RLS (strongest, but it needs a per-request `SET LOCAL` session variable, which conflicts with connection pooling unless every transaction sets it).

The chosen approach is deliberately explicit and verifiable: isolation is asserted by e2e tests that create a second organization. RLS remains a documented hardening step rather than a substitute for getting this right.

### D4 — Stateless access tokens, revocable hashed refresh tokens

The access token is a short-lived signed JWT carrying `{ sub, org, role }`, so the guard needs no database round-trip and tenant identity is tamper-proof. The refresh token is an opaque random value stored only as a SHA-256 digest, which is what makes revocation possible at all. **Alternatives:** long-lived JWTs only (cannot be revoked; a leaked token is valid until expiry); server-side sessions in Redis (revocable, but adds a dependency read to every request and a new failure mode when Redis is down); access-token denylist (reintroduces the per-request lookup that stateless tokens exist to avoid).

The cost of statelessness is that a removed membership stays usable until the access token expires, which is why the TTL is deliberately short and the refresh path re-reads the membership row.

### D5 — Refresh rotation is single-use, and reuse revokes the family

A refresh consumes its row and issues a new pair. Presenting an already-revoked token means the value was copied (or a client raced itself), so the response is to revoke every live refresh token for that user: the legitimate client signs in again, the copy is dead. **Alternative:** silently accept rotation without reuse detection — simpler, but it leaves a stolen token usable alongside the legitimate session indefinitely, with nothing to distinguish them.

### D6 — Password hashing on Node's built-in scrypt

`node:crypto.scrypt` with N=2^15, r=8, p=1, a 16-byte random salt, and self-describing digests (`scrypt$N$r$p$salt$hash`) so cost parameters can be raised later without invalidating stored credentials. **Alternatives:** `argon2` (the modern recommendation, but a native module in a musl image — build toolchain or prebuilt gamble), `bcrypt`/`bcryptjs` (native, or pure-JS and slow). scrypt is OWASP-accepted, ships in the platform, behaves identically on host and in the container, and adds no dependency. The parameters are bounded when reading a digest so a corrupt or hostile row cannot demand an absurd `N` and turn a login into a memory bomb.

### D7 — Cross-organization reads are 404, not 403

An event id that exists in another organization is reported exactly like an id that does not exist. A 403 would confirm the row exists, letting an authenticated tenant enumerate other tenants' identifiers. The same reasoning is applied to login: a wrong password and an unknown email produce the same 401 and comparable timing.

### D8 — Queue job identity is tenant-qualified

The job id is derived from both the organization and the employee id (`perEmployeeJobId`), joining percent-encoded parts with `|`. BullMQ's per-`jobId` suppression is what implements per-employee FIFO, and employee ids are now tenant-local — so a bare `employeeId` would make two organizations share a slot, letting one tenant's backlog suppress and delay another's events.

Two constraints shaped the exact form, and the first was learned the hard way: **BullMQ rejects a custom id containing `:` unless it splits into exactly three segments** (a legacy repeatable-job compatibility check). An earlier `<organizationId>:<employeeId>` form therefore threw on *every* enqueue, and because the producer treats enqueue failure as non-fatal by design (the row is the source of truth), the error was swallowed and events sat in `queued`. That is the failure mode the design's "never let enqueue fail the submission" rule trades for, so the job id was changed to a colon-free `|` join and the unit spec now asserts both the absence of a colon and injectivity when an identifier itself contains the separator. Percent-encoding both parts makes the mapping injective by construction: distinct (organization, employee) pairs can never collapse onto one id.

**Alternatives:** one queue per organization (clean isolation, but dynamic queue names complicate worker registration and health checks); a BullMQ group/priority scheme (heavier than needed); a hash of the pair (injective in practice but opaque, and collisions would be silent).

### D9 — The organization travels in job data and scopes the worker

Job data carries `organizationId`, and the claim, pre-queue flip, relay lookup, and exhaustion write are all scoped by it. **Alternative:** have the worker derive the organization from the event row only. That reads well but means a forged or corrupted job naming a valid foreign event id would still let the worker lock and mutate another tenant's row — the row is identified by a UUID, so "I know the id" would be sufficient authority. Carrying the tenant and checking both makes the row lock itself tenant-scoped.

### D10 — `employeeId` stays a tenant-local string

No `employees` table in this change. Employee numbers come from the customer's own payroll system, so they are naturally tenant-scoped identifiers; the composite unique key already keeps sequences independent per organization. Adding a roster would mean deciding how employees are created and synced, and would break every existing test that submits an arbitrary employee id — real work, but a separate change with its own spec.

### D11 — Registration creates a new organization

`POST /auth/register` always creates a tenant and its `OWNER`. There is deliberately no path to join an existing organization: without invitations (a later change), any such path would be a way into someone else's tenant. An organization slug is derived from its name and disambiguated on collision rather than rejected, because two companies may legitimately share a display name.

### D12 — The frontend gains only the authentication it needs

The existing spec requires the UI to submit events, which is impossible once `POST /events` requires a token — so this change must include UI authentication or it knowingly breaks a shipped requirement. The scope is kept to: sign-in/registration, retaining the session across reloads, attaching the token, one transparent refresh on 401, and sign-out. No member administration, no role-gated views. Token storage remains `localStorage`, consistent with how the UI already persists its tracked-event list, with the XSS trade-off recorded below.

## Risks / Trade-offs

- **A revoked membership stays usable until the access token expires** → the TTL is short (15 min default) and the refresh path re-validates the membership row, bounding the window.
- **A future query could forget the tenant filter** → the organization is a required argument on every tenant-scoped method (a missing argument is a compile error, not a silent full-table read), tenant-leading composite indexes make the intended access path the natural one, and isolation tests exercise cross-tenant reads as a first-class case. RLS is the planned defence-in-depth follow-up.
- **`localStorage` tokens are exposed to XSS** → accepted for this stage; the alternative (httpOnly cookies) needs CSRF handling and changes the API's auth model, and the app currently ships no user-generated HTML. Recorded here so the choice is visible.
- **The migration creates a legacy tenant that nobody can sign in as** → it is created only when there is pre-existing data, its id is deterministic, and it is named `Legacy Tenant` / `legacy`. Claiming or migrating its rows is an operational step, noted in the README.
- **Expired refresh rows accumulate** → they are revocable and indexed by expiry; a sweep mirroring the idempotency sweeper is a small follow-up rather than part of this change.
- **A required `AUTH_JWT_SECRET` breaks any existing deployment that lacks it** → intentional (fail fast beats signing with a guessable key); `.env.example`, the stage env files, the compose environment, and the CI e2e job are all updated together, and the README calls it out.
- **Every e2e suite now needs credentials** → a single shared authenticated-request helper keeps this a mechanical change rather than seven bespoke ones, and gives isolation tests the same foundation.
- **Two specs were already out of date before this change** → `event-processing` requires that transient attempts create no `event_attempts` row, while the code records every attempt; and `event-submission` lists three event types while the code accepts four (`DEPARTMENT_CHANGE`). Both came from commits that bypassed OpenSpec. They are surfaced as open questions rather than quietly corrected here, because each is a spec-level change in its own right.
- **The worker could not boot at all before this change** → the `DEPARTMENT_CHANGE` commit registered `DepartmentChangeHandler` in the `HandlerRegistry` but never added it to `ProcessingModule.providers`, so the worker module failed dependency resolution and every suite that booted it failed in `beforeAll`. Fixed here with one import and one provider entry, because this change's e2e coverage (and any working queue) is impossible without it — but the fix properly belongs to that feature, and the fact that it reached `main` unnoticed is the same process gap the two stale specs point at.

## Migration Plan

1. **Apply the migration** — five parts, in order: create the tenant/identity tables; seed the legacy organization *only if* `payroll_events` or `idempotency_records` already hold rows; add `organization_id` nullable, backfill, then `SET NOT NULL` with no default; add the foreign keys; then swap the unique keys and replace single-column indexes with tenant-leading ones and add the `event_attempts` → `payroll_events` foreign key.
2. **Deploy order** — the API entrypoint already runs `prisma migrate deploy` before starting, so the schema is in place before either application process serves traffic. The worker is a separate process and must be restarted with the new job-data shape; jobs already in Redis during the upgrade carry no `organizationId` and are **not** forward-compatible, so the safe sequence is to drain or flush the queue before deploying the worker, or to let the affected events be recovered from their rows by the relay.
3. **Rollback** — reverting the image restores the previous code, but the schema change is not reversible in place (the `NOT NULL` discriminator and replaced unique keys). Rollback therefore means restoring from a pre-migration backup; in a single-tenant deployment the data remains readable because every row carries the legacy organization.
4. **Post-deploy verification** — `/health` reachable without credentials; register an organization; submit an event and confirm it is only visible to that session; confirm a second organization cannot read it.

## Open Questions

- **`event-processing` vs. the code on attempt recording.** The spec says retried transient attempts write no `event_attempts` row; the code appends a `FAILED(TEMPORARY)` row for each attempt and upserts the final one. The spec needs to be brought in line (or the behaviour reverted) by its own change.
- **`event-submission` vs. the code on event types.** The spec lists three event types; the code also accepts `DEPARTMENT_CHANGE`. A `DEPARTMENT_CHANGE` delta (or a spec update) should reconcile this.
- **Role enforcement.** Roles are recorded and carried in the token but no endpoint requires one yet; which operations should require `OWNER`/`ADMIN` is a product decision for the next change.
- **Refresh-token sweep cadence.** Whether to reuse `IDEMPOTENCY_SWEEP_INTERVAL_MS`'s pattern or give refresh tokens their own interval can be decided when the sweep is written.
