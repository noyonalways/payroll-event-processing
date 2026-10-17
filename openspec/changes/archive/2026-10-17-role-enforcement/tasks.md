# Tasks

## 1. Guard, decorator, and wiring

- [x] 1.1 Add the role-hierarchy map and metadata key to `packages/core/src/auth/auth.constants.ts`, implement `packages/core/src/auth/decorators/roles.decorator.ts` (`@Roles(...)` + Swagger `@ApiRoles()` stamping `x-required-role`) and `packages/core/src/auth/guards/roles.guard.ts` (reflector metadata, at-or-above comparison, 403 via the shared error filter's shape) — unit-test the hierarchy map, at-or-above semantics, and no-metadata default with the existing guard-test convention — verify `MEMBER < ADMIN < OWNER` ordering and that a no-metadata route allows any role.
- [x] 1.2 Register `RolesGuard` globally in `packages/core/src/app.module.ts` after `JwtAuthGuard` — verify in the app-level test that guards run JWT first (401 beats 403) and the guard is global (no per-controller imports).

## 2. Apply the baseline matrix

- [x] 2.1 Annotate the recovery actions in `packages/core/src/events/events.controller.ts` (`retry`, `cancel`) and employee mutations in `packages/core/src/employees/employees.controller.ts` (`create`, `update`, `remove`) with `@Roles(MembershipRole.ADMIN)` — verify reads, submission, auth and stream controllers have no annotation (default any-member) in the coverage sweep below.
- [x] 2.2 Update the controller spec files for the two controllers to cover the new role dimension: admin/owner succeed, member receives `403` with the structured error body before any service call — verify existing status-code tests still pass unchanged.
- [x] 2.3 e2e coverage (`test/rbac.e2e-spec.ts`): a MEMBER token denied on `POST /events/:id/retry|cancel` and employee create/patch/delete with `403`, allowed on submission and all reads with expected results; an ADMIN/OWNER token allowed everywhere; unauthenticated calls still `401`; a valid OWNER token probing another organization's event id still `404` — verify the tenancy-before-role ordering end to end. Verify regression: cross-tenant `404` semantics untouched for elevated roles.

## 3. Documentation and sweep

- [x] 3.1 Sweep every controller in `packages/core/src` and record the declared role posture per route (annotated vs default); confirm each state-changing route either matches the baseline matrix or explicitly declares a role — deliver as a short table in the change's notes; verify no mutating route is unintentionally relying on the any-member default.
- [x] 3.2 Update Swagger descriptions for the newly gated operations (403 response + role requirement) and the README authorization section — verify `/api-docs` renders the role metadata and the structured 403 example.
- [x] 3.3 Run `pnpm lint` + backend unit/e2e suites — verify all green, including the updated e2e suites that now authenticate with differing role tokens.
