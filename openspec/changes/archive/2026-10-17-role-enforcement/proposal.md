# Proposal

## Why

Every authenticated caller can currently perform every operation in their organization: a MEMBER
role can retry failed events, cancel queued ones, and mutate the employee directory, because
`multi-tenant-foundation` introduced OWNER/ADMIN/MEMBER roles but nothing enforces them — the
signed JWT carries the role, only the tenant boundary checks it. Tenancy without authorization
means one low-privileged account can take business-critical actions; role enforcement is the
next queued item to complete the tenancy model's authorization story.

## What Changes

- New **role hierarchy** and enforcement model: `OWNER > ADMIN > MEMBER`, with a guard that
  accepts callers at-or-above the minimum role an endpoint declares.
- **`@Roles()` declaration + global `RolesGuard`** wired after the existing JWT guard: read and
  authentication endpoints stay open to any authenticated member; operational actions gain
  minimum roles.
- **Enforcement matrix** (baseline):
  - Any authenticated member (incl. MEMBER): event submission, all reads (`GET /events`,
    `GET /events/:id`, `GET /employees`, `GET /employees/:id`, SSE stream, `GET /auth/me`),
    logout, refresh.
  - ADMIN or OWNER (`ADMIN+`): retry and cancel (`POST /events/:id/retry|cancel`) and employee
    directory mutations (`POST /employees`, `PATCH /employees/:id`, `DELETE /employees/:id`).
- Denied callers receive HTTP `403` with the standard `ErrorResponseDto`, with cross-tenant
  requests still reported as `404` (never revealing existence).
- New endpoints written hereafter declare their minimum role the same way (the guard is global
  and default-deny-by-annotation for role-gated routes).

## Capabilities

### New Capabilities
- `access-control`: Role-based access control across the API — the OWNER/ADMIN/MEMBER hierarchy,
  per-endpoint minimum-role declarations, the deny-tolerant global guard, and 403 semantics.

### Modified Capabilities
- `event-recovery`: Retry and cancel SHALL require an ADMIN-or-higher membership role; a MEMBER
  caller is denied with HTTP 403 (the state-transition contract itself is unchanged).
- `employee-directory`: Employee registration and mutation (create, patch, archive) SHALL require
  an ADMIN-or-higher membership role; reading stays open to any member.

## Impact

- **API**: `403 Forbidden` becomes possible on previously-open endpoints; documented in Swagger
  via role metadata on each operation.
- **Code**: new `RolesGuard` + `@Roles()` decorator beside the existing auth guards/decorators in
  `packages/core/src/auth/`; one-line annotations on controllers; no service-layer changes.
- **Frontend**: unchanged this change — the UI is not role-aware; a MEMBER clicking a disabled-
  limited action will simply see the 403 surfaced by the existing error handling. Role-aware UI
  affordances ride along with `org-membership-management`.
- **Tenancy spec**: unchanged — roles already exist on memberships and in token claims;
  this change only starts enforcing them.

## Non-goals

- No membership/invitation management UI or API (handled by `org-membership-management`) and no
  role-change endpoints — OWNER and ADMIN are capability-equal in this baseline.
- No fine-grained (per-field, per-event-type) permissions — three-role hierarchy only.
- No frontend role-awareness in this change.
