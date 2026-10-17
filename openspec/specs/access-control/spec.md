# access-control Specification

## Purpose

Enforce the OWNER/ADMIN/MEMBER roles that membership records and access-token claims already
carry, so operations that are safe to view are not automatically safe to perform — giving every
endpoint a declared minimum role checked consistently behind authentication and tenancy.

## Requirements

### Requirement: Roles form a strict hierarchy checked at or above a minimum

The system SHALL treat membership roles as a strict hierarchy `OWNER > ADMIN > MEMBER` and SHALL
grant a caller an operation that declares a minimum role when the caller's role is that role or
any higher one. A caller's role for an API request SHALL be the role claimed in the verified
access token (kept consistent with the membership record at token mint time).

#### Scenario: Admin satisfies an admin-gated operation
- **WHEN** a caller with role ADMIN invokes an operation whose minimum role is ADMIN
- **THEN** the operation SHALL execute as usual

#### Scenario: Owner satisfies an admin-gated operation
- **WHEN** a caller with role OWNER invokes an operation whose minimum role is ADMIN
- **THEN** the operation SHALL also execute, because OWNER outranks ADMIN

#### Scenario: Member does not satisfy an admin-gated operation
- **WHEN** a caller with role MEMBER invokes an operation whose minimum role is ADMIN
- **THEN** the operation SHALL NOT execute
### Requirement: Endpoints declare their minimum role and denials are 403

The system SHALL let every operation declare the minimum role required, with `read` and
authentication operations open to any authenticated member unless declared otherwise. For a
caller whose role does not satisfy the declared minimum, the system SHALL reject the request
with HTTP `403` and the structured error body before any service logic runs; role SHALL never be
the reason a request is silently downgraded. Authentication posture SHALL be evaluated before
role: an unauthenticated or invalidly tokened caller SHALL still receive HTTP `401`, and a valid
token naming a resource of another organization SHALL still receive HTTP `404` regardless of
role, preserving the tenancy rule that cross-organization access is indistinguishable from
absence. The baseline matrix SHALL be: submission (`POST /events`), all reads (events list,
event detail, employee directory, employee detail, the SSE lifecycle stream, `GET /auth/me`),
and session refresh/logout SHALL require any authenticated member; event retry and cancel
(`POST /events/:id/retry|cancel`) and employee mutations (`POST /employees`,
`PATCH /employees/:id`, `DELETE /employees/:id`) SHALL require ADMIN or higher.

#### Scenario: Member may submit events and read everything
- **WHEN** a caller with role MEMBER submits an event or reads the events list, an event detail,
  the employee directory, or the SSE stream
- **THEN** each request SHALL succeed exactly as it would for any other role

#### Scenario: Member is denied a recovery action with 403
- **WHEN** a caller with role MEMBER calls `POST /events/:id/retry` or `POST /events/:id/cancel`
- **THEN** the response SHALL be HTTP `403` with the structured error body, and the event SHALL
  be unchanged

#### Scenario: Member is denied an employee mutation with 403
- **WHEN** a caller with role MEMBER creates, patches, or archives an employee
- **THEN** the response SHALL be HTTP `403` with the structured error body, and no record SHALL
  change

#### Scenario: Authentication still precedes authorization
- **WHEN** a client without a valid access token calls an admin-gated operation
- **THEN** the response SHALL be HTTP `401`, not `403`

#### Scenario: Cross-organization access still reports 404
- **WHEN** a caller with role OWNER requests an event id belonging to a different organization
- **THEN** the response SHALL be HTTP `404` with the unknown-id error shape, never a role error
