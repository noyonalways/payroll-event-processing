# Spec Delta

## Purpose

Gate employee directory mutations behind an ADMIN-or-higher membership role while keeping the
directory readable by every member, so the roster is shared knowledge but changes to it are
operator actions.

## MODIFIED Requirements

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
