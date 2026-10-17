# Design

## Context

`multi-tenant-foundation` already mints access tokens carrying `role: MembershipRole` (Prisma
enum `OWNER | ADMIN | MEMBER`), resolves them into `AuthenticatedActor`
(`packages/core/src/auth/authenticated-actor.ts`) via `JwtAuthGuard`, and exposes
`CurrentActor`/`Public` decorators. Authorization today stops at the tenant boundary — no
endpoint checks the role. Operations to gate: recovery actions in
`packages/core/src/events/events.controller.ts` (`POST /events/:id/retry|cancel`), employee
mutations in `packages/core/src/employees/employees.controller.ts` (`POST /employees`,
`PATCH|DELETE /employees/:id`), and the guard wiring for everything else.

## Goals / Non-Goals

**Goals:**

- One declarative mechanism (`@Roles()` + global guard) so new endpoints declare intent in one
  line and enforcement is uniform.
- Ordering guarantees: authentication → tenant isolation → role (401 and 404 semantics preserved).

**Non-Goals:**

- Membership management and role-change APIs (next queued change); role-aware UI.

## Decisions

### D1 — Framework-native `RolesGuard` with reflector metadata, no policy engine

A new `roles.guard.ts` in `packages/core/src/auth/guards/` reads `@Roles(...MembershipRole[])`
metadata via `Reflector` and compares `actor.role` against the declared minimum using a
hierarchy map (`MEMBER: 1, ADMIN: 2, OWNER: 3`); a route without metadata allows any
authenticated actor (the JWT guard already forced authentication globally —
`Public` is the only opt-out). Nest guards run AFTER global guards-in-chain ordering with
`JwtAuthGuard` first, giving the required 401-before-403 ordering. Chosen over a Casbin/ACL
library because three fixed roles need no policy engine and the ecosystem dependency would buy
nothing. Alternatives rejected: per-controller guards (enforcement drift), service-layer checks
(duplicated, forgettable).

### D2 — Minimum-role annotation style, allow-at-or-above semantics

`@Roles(MembershipRole.ADMIN)` means "ADMIN or higher" — with OWNER implicitly satisfying every
ADMIN gate — rather than an exact-role match, so a future MEMBER-gate plus role additions never
strands OWNER. Routes with no annotation stay "any authenticated member" (reads, submission,
auth session routes); this is intentional documented defaulting, not an oversight — the guard
fails closed only for routes that declare a minimum.

### D3 — Ordering: tenant isolation resolves before role

Cross-organization ids MUST keep returning `404`, never `403` — the guard runs after
`JwtAuthGuard` but before controller bodies, while tenant scoping happens in services, so for a
route the role check cannot distinguish "resource exists for another org". Because role denial
is resource-independent (it gates the operation, not the resource), evaluating it before the
service call preserves tenancy semantics exactly: a MEMBER probing another org's event with
`POST /:id/cancel` receives `403` (operation denied regardless of target), an ADMIN receives
`404` (resource invisible). This asymmetry is deliberate and matches the access-control spec's
scenarios.

### D4 — Swagger surface

Each gated operation is annotated so `/api-docs` lists the role requirement (`@ApiBearerAuth` +
a reusable `@ApiRoles()` decorator that stamps a `x-required-role` extension), and the global
error contract gains a `403` response reference for gated routes. The `ErrorResponseDto` shape
is unchanged.

### D5 — Wiring points (exact edits)

- `packages/core/src/auth/guards/roles.guard.ts` (new), `packages/core/src/auth/decorators/roles.decorator.ts` (new), `packages/core/src/auth/auth.constants.ts` (metadata key), registered globally in `packages/core/src/app.module.ts` beside the JWT guard.
- `events.controller.ts`: `@Roles(ADMIN)` on `retry`/`cancel`; `employees.controller.ts`: `@Roles(ADMIN)` on create/patch/delete.
- No DB, migration, or token-claims changes: the role is already in claims and validated against the membership at mint time (tenancy spec's "Memberships bind users to organizations with a role" continues to own role storage).

## Risks / Trade-offs

- [Role in JWT can go stale after a role change until token refresh] → acceptable baseline;
  `org-membership-management` owns revocation-on-role-change (access tokens are short-lived by
  the authentication spec).
- [Silent default of "any authenticated member" could under-protect a future endpoint] → the
  design review convention: any state-changing operation must either be reviewed for the default
  or carry an explicit `@Roles()`; tasks include a controller-coverage sweep as verification.
- [OWNER and ADMIN are capability-equal today] → deliberate; differentiation arrives with
  member-management where only OWNER should change roles.

## Migration Plan

Prerequisite: the `employee-directory` change (implemented, pending archive) must be archived
first — this change MODIFIES its spec, which does not exist in main specs until then. Purely
additive code otherwise; no schema or data migration. Deploy with the global guard registered —
routes without annotations keep their exact today-behaviour, so rollout is safe even if an
annotation is missed. Rollback: remove the guard registration.

## Open Questions

None.
