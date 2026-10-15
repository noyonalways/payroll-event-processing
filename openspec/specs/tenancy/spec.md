# tenancy Specification

## Purpose
Makes an organization the boundary for all payroll data. Every tenant-owned row records its organization, every tenant-scoped operation is filtered by the caller's organization, and a caller cannot observe or affect another organization's data — a foreign identifier is reported exactly as if it did not exist.

## Requirements

### Requirement: Organizations own their data
The system SHALL model an organization as the owner of all payroll data, and SHALL record the owning organization on every tenant-owned row. The organization SHALL be required on each such row: the system SHALL NOT permit a tenant-owned row to exist without an organization, and SHALL NOT apply a default that would let a write omit it. The system SHALL provide no endpoint that reads or writes across organizations.

#### Scenario: Submitted events record their organization
- **WHEN** an authenticated client submits an event
- **THEN** the persisted event row SHALL record the organization of the caller's session

#### Scenario: No implicit organization
- **WHEN** a payroll event or idempotency record is written
- **THEN** the write SHALL supply the organization explicitly and SHALL fail rather than default if it is absent

#### Scenario: Organization removal takes its data
- **WHEN** an organization is removed
- **THEN** its events and idempotency records SHALL be removed with it, and no attempt row SHALL be left referencing a removed event

### Requirement: Tenant-scoped reads are filtered by the caller's organization
Every read of tenant-owned data SHALL be constrained to the organization of the caller's session, and the organization SHALL be derived from the authenticated session rather than from any client-supplied input. A client SHALL NOT be able to influence which organization a request operates on by supplying or modifying a request body field, query parameter, or header other than its access token.

#### Scenario: Client reads its own event
- **WHEN** an authenticated client requests the status of an event belonging to its organization
- **THEN** the response SHALL be HTTP `200` with that event's details

#### Scenario: Organization cannot be steered by the request
- **WHEN** an authenticated client requests an event that belongs to another organization, supplying that organization's identifier in the body or as a query parameter
- **THEN** the request SHALL be evaluated against the organization in the caller's access token only

### Requirement: Cross-organization access is indistinguishable from absence
A request for a tenant-owned resource that belongs to a different organization SHALL be reported exactly as if the resource did not exist, using the same status and error body as an unknown identifier, so that the API cannot be used to discover which identifiers exist in other organizations.

#### Scenario: Foreign event reports not found
- **WHEN** an authenticated client requests the status of an event that exists only in another organization
- **THEN** the response SHALL be HTTP `404` and SHALL be indistinguishable from the response for an identifier that does not exist anywhere

#### Scenario: Foreign event cannot be processed
- **WHEN** a queue job names an event identifier that belongs to a different organization than the job carries
- **THEN** the worker SHALL NOT claim, mutate, or record an attempt against that event

### Requirement: Employee identifiers are scoped to their organization
An `employeeId` supplied in a payload SHALL be interpreted within the submitting client's organization. Two organizations SHALL be able to use the same `employeeId` without their events, ordering sequences, or per-employee processing interfering with one another.

#### Scenario: Same employee number in two organizations
- **WHEN** two organizations each submit an event for `employeeId` `emp-1` as their first event for that employee
- **THEN** both events SHALL be accepted and each SHALL have a `sequence` of 1

#### Scenario: Ordering does not leak across organizations
- **WHEN** one organization has submitted several events for `emp-1` and another organization submits its first event for `emp-1`
- **THEN** the second organization's event SHALL start a fresh sequence and SHALL NOT be ordered behind the first organization's events

#### Scenario: Per-employee processing does not serialize across organizations
- **WHEN** two organizations have pending events for the same `employeeId`
- **THEN** each organization's events SHALL be processed in their own order and SHALL NOT wait on the other organization's in-flight event

### Requirement: Idempotency keys are scoped to their organization
An `Idempotency-Key` supplied by a client SHALL be deduplicated within the organization that supplied it. A key value used by one organization SHALL NOT cause a submission by another organization to be treated as a duplicate, and SHALL NOT cause one organization to receive another organization's stored response.

#### Scenario: Same key in two organizations does not dedupe
- **WHEN** organization A submits an event with key `k-1`, and organization B submits a different event with the same key `k-1`
- **THEN** organization B's event SHALL be created and SHALL receive its own stored response rather than organization A's

#### Scenario: Replay stays inside the organization
- **WHEN** organization A resubmits with a key it previously used
- **THEN** the stored response returned SHALL be the one organization A received, and it SHALL NOT be readable by any other organization

### Requirement: Memberships bind users to organizations with a role
The system SHALL represent the relationship between a user and an organization as a membership carrying a role of `OWNER`, `ADMIN`, or `MEMBER`, and SHALL allow a user to hold memberships in more than one organization. A user SHALL NOT be able to act in an organization they hold no membership in, and the role SHALL be conveyed in the session so that later changes can enforce it.

#### Scenario: Membership is required to act in an organization
- **WHEN** an authenticated user attempts to submit or read payroll data for an organization they are not a member of
- **THEN** the request SHALL be rejected and no data SHALL be returned

#### Scenario: A user may belong to several organizations
- **WHEN** a user holds memberships in two organizations
- **THEN** they SHALL be able to hold a session for each, and each session SHALL see only its own organization's data

#### Scenario: Removing a membership ends access
- **WHEN** a user's membership in an organization is removed
- **THEN** they SHALL NOT be able to refresh into a new session for that organization
