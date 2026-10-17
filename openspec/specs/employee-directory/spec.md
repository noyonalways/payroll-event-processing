# employee-directory Specification

## Purpose

Give every organization an authoritative roster of its employees — the shared identity that
event payloads reference as `employeeId`, the UI can browse and maintain, and future
employee-attached data (compensation, bank accounts) can hang off — so event submission can stop
accepting free-form identifiers for people the organization has never registered.

## Requirements

### Requirement: The organization owns its employee directory

The system SHALL maintain an `employees` directory in which every employee record belongs to
exactly one organization. A record SHALL carry a tenant-local employee number (`employeeNumber`)
— the same identifier event payloads reference as `employeeId` — together with a display name,
an optional department, an active flag, and creation/update timestamps. Employee numbers are
matched exactly as stored, and SHALL be unique within their organization; two organizations
SHALL be able to register the same employee number as fully independent employees, consistent
with the tenancy rule for event employee identifiers.

#### Scenario: Employee record belongs to one organization
- **WHEN** an authenticated client creates an employee
- **THEN** the stored record SHALL belong to the organization of the client's access token

#### Scenario: Same employee number in two organizations is independent
- **WHEN** organizations A and B each register an employee numbered `emp-001`
- **THEN** both records SHALL exist as separate employees, each readable and updatable only
  inside its own organization

#### Scenario: Events and the directory share one identifier
- **WHEN** an event is submitted for `employeeId` `emp-001` in an organization whose directory
  contains an active employee numbered `emp-001`
- **THEN** the persisted event SHALL remain associated with that identifier, and the directory
  row SHALL keep the same stored number
### Requirement: Employees can be registered

The system SHALL expose `POST /employees`, requiring an access token like every payroll
operation and a membership role of ADMIN or higher; a caller below the minimum role SHALL be
rejected with HTTP `403`. The body SHALL consist of `employeeNumber` (non-empty string), `name`
(non-empty string), and optionally `department`. On success the system SHALL return HTTP `201`
with the employee's representation (`id`, `employeeNumber`, `name`, `department` or `null`,
`active` (`true` at creation), `createdAt`, `updatedAt`) and no request SHALL mutate any existing
record. A body that is missing or has blank required fields SHALL be rejected with HTTP `400`.
Registering a number that already exists in the caller's organization — including an archived
one — SHALL be rejected with HTTP `409`; employee numbers stay reserved after archiving. The
employee number of a created record SHALL NEVER change through any endpoint.

#### Scenario: Create an employee
- **WHEN** an authenticated client with role ADMIN or higher POSTs `{ "employeeNumber": "emp-001", "name": "Ada", "department": "Engineering" }` to `/employees`
- **THEN** the response SHALL be HTTP `201` with the full representation of the new active employee

#### Scenario: Duplicate number inside the organization is a conflict
- **WHEN** an authenticated client POSTs an employee whose `employeeNumber` already exists in their organization
- **THEN** the response SHALL be HTTP `409` and no second record SHALL be created

#### Scenario: Invalid body
- **WHEN** a client POSTs an employee with a blank `name` or a missing `employeeNumber`
- **THEN** the response SHALL be HTTP `400` with a structured error body naming the failing fields

#### Scenario: Member is denied registration with 403
- **WHEN** an authenticated client with role MEMBER POSTs a valid new employee body to `/employees`
- **THEN** the response SHALL be HTTP `403` with the structured error body, and no record SHALL be created

#### Scenario: Registration without a token is rejected
- **WHEN** a client POSTs to `/employees` without an `Authorization` header, or with an invalid or expired token
- **THEN** the response SHALL be HTTP `401` and no record SHALL be created

### Requirement: The directory can be browsed with stable pagination

The system SHALL expose `GET /employees`, requiring an access token, returning HTTP `200` with a
body carrying `data` (the employees matching the request), `limit` (the requested page size), and
`nextCursor` (an opaque token for the next page, or `null` when no further page exists). Pages
SHALL be ordered by employee number ascending and SHALL be deterministic: the order SHALL NOT
depend on when unrelated records were created or updated, and pagination SHALL work by exact
seek position — an employee created after earlier pages were fetched SHALL NOT shift rows between
pages. An unparsable cursor SHALL be rejected with HTTP `400`, not treated as absent. The
endpoint SHALL accept combinable filters: `active` (restricts to active or archived employees)
and `search` (case-insensitive substring match over employee number and name); filters SHALL
combine with AND and compose with pagination. A page size outside the documented range SHALL be
rejected with HTTP `400`.

#### Scenario: First page of the directory
- **WHEN** an authenticated client calls `GET /employees` with no parameters
- **THEN** the response SHALL be HTTP `200` with that organization's employees ordered by
  employee number ascending, a `limit`, and a `nextCursor` that is `null` only when the
  directory is exhausted

#### Scenario: Walking all pages yields every employee exactly once
- **WHEN** a client repeatedly requests pages following `nextCursor` until it is `null`
- **THEN** the concatenation of `data` SHALL contain each of the organization's employees exactly once

#### Scenario: Pages stay stable while employees are added
- **WHEN** a client fetches page 1, a colleague registers a new employee, and the client then fetches page 2
- **THEN** page 2 SHALL continue from the same position as before, unshifted by the new record

#### Scenario: Search and the active filter narrow the list
- **WHEN** a client calls `GET /employees?search=ada&active=false`
- **THEN** only that organization's archived employees whose number or name matches `ada`
  (case-insensitively) SHALL be returned

#### Scenario: Malformed cursor or page size is rejected
- **WHEN** a client passes an undecodable `cursor` or a `limit` outside the documented range
- **THEN** the response SHALL be HTTP `400` with the structured error body
### Requirement: An employee can be viewed, corrected, and archived

The system SHALL expose `GET /employees/:id`, `PATCH /employees/:id`, and `DELETE
/employees/:id` within the caller's organization. `GET` SHALL remain open to any authenticated
member and SHALL return HTTP `200` with the full representation, or HTTP `404` for an unknown id.
`PATCH` and `DELETE` SHALL require a membership role of ADMIN or higher; a caller below the
minimum role SHALL be rejected with HTTP `403`. `PATCH` SHALL accept `name`, `department`, and
`active` and SHALL return the updated representation with HTTP `200`; an attempt to change
`employeeNumber` SHALL be rejected with HTTP `400`. `DELETE` SHALL archive the employee — setting
`active` to `false` — with HTTP `204`; it SHALL NOT delete the record, SHALL NOT rewrite or
remove any event history that references the employee number, SHALL NOT free the number for
reuse, and SHALL be idempotent (archiving an already-archived employee SHALL again return `204`).
An archived employee SHALL remain retrievable and SHALL still appear in the directory unless
filtered out.

#### Scenario: An employee's details are corrected
- **WHEN** an authenticated client with role ADMIN or higher PATCHes a visible employee with a new `department`
- **THEN** the response SHALL be HTTP `200` and the stored record SHALL reflect the change

#### Scenario: The employee number is immutable
- **WHEN** a client PATCHes an employee including a different `employeeNumber`
- **THEN** the response SHALL be HTTP `400` and the stored number SHALL be unchanged

#### Scenario: Deleting archives instead of erasing
- **WHEN** an authenticated client with role ADMIN or higher DELETEs an active employee
- **THEN** the response SHALL be HTTP `204`, the record SHALL remain with `active = false`, and
  every event previously submitted for that employee number SHALL remain readable and unchanged

#### Scenario: Member is denied corrections and archiving
- **WHEN** an authenticated client with role MEMBER PATCHes or DELETEs an employee
- **THEN** the response SHALL be HTTP `403` with the structured error body, and the record SHALL
  be unchanged

#### Scenario: Member can still read the directory
- **WHEN** an authenticated client with role MEMBER GETs the directory list or a single employee
- **THEN** the response SHALL be HTTP `200` exactly as for any other role

#### Scenario: Delete is idempotent
- **WHEN** a client DELETEs the same employee twice
- **THEN** both responses SHALL be HTTP `204` and the record SHALL exist exactly once

#### Scenario: Unknown employee
- **WHEN** a client GETs, PATCHes, or DELETEs an employee id that does not exist in their organization
- **THEN** the response SHALL be HTTP `404` with the structured error body

### Requirement: Directory records are tenant-isolated

The directory SHALL enforce cross-organization isolation exactly like every other tenant-owned
capability: `GET /employees` SHALL return only the caller's organization's employees, and any
single-employee endpoint reached with another organization's id SHALL respond with HTTP `404` —
indistinguishable from an unknown id — and SHALL NOT modify the record.

#### Scenario: Another organization's employee reads as absent
- **WHEN** a client of organization A calls `GET /employees/:id` (or PATCHes / DELETEs) with the
  id of organization B's employee
- **THEN** the response SHALL be HTTP `404` and organization B's record SHALL be unchanged

#### Scenario: Listing never crosses the tenant boundary
- **WHEN** two organizations each have employees and a client of organization A calls `GET /employees`
- **THEN** `data` SHALL contain only organization A's employees, regardless of any filter or page parameter
### Requirement: Every organization owns the demo employees

The five reserved scenario employees — `EMP-DEMO-SUCCESS`, `EMP-DEMO-RECOVER`,
`EMP-DEMO-TRANSIENT`, `EMP-DEMO-FAILAFTER`, and `EMP-DEMO-PERMANENT` — SHALL exist as active
directory employees in every organization: created when an organization is registered, and
backfilled for organizations that already exist (without overwriting any of their directory
rows or event history). Submissions for these identifiers SHALL then pass the event-submission
directory check like any other employee, so the documented `EMP-DEMO-*` demo convention and the
UI's scenario selector keep working unchanged.

#### Scenario: A new organization starts with the demo employees
- **WHEN** a user registers an organization
- **THEN** its directory SHALL contain the five active demo employees alongside any the
  organization's users create later

#### Scenario: An existing organization gains its missing demo employees
- **WHEN** a change-migration runs against an organization that predates the directory (or is
  missing some demo employees)
- **THEN** the missing demo rows SHALL be added as active employees, and no existing directory
  row or stored event SHALL be modified

#### Scenario: Demo submissions remain accepted
- **WHEN** a client submits an event for `employeeId` `EMP-DEMO-RECOVER` in an organization with a seeded directory
- **THEN** the submission SHALL be accepted with HTTP `201` and processed by the usual demo lever
### Requirement: The directory endpoints document themselves

`POST /employees`, `GET /employees`, `GET /employees/:id`, `PATCH /employees/:id`, and
`DELETE /employees/:id` SHALL be documented in the OpenAPI document with their bearer
requirement, their typed success responses, and their `400`/`401`/`404`/`409` error responses.

#### Scenario: Directory routes appear in the OpenAPI document
- **WHEN** a client fetches the OpenAPI document (`GET /api-docs-json`)
- **THEN** the five employees routes SHALL be listed with the bearer-authorization requirement,
  their typed success responses, and the documented error statuses
