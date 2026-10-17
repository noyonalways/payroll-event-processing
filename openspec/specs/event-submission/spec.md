# Event Submission

## Purpose

Expose a `POST /events` API that lets clients submit typed payroll events (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`) with per-type payload validation, mandatory `Idempotency-Key` deduplication, and event persistence with a per-employee ordering sequence so downstream processing can replay events reliably in order.

## Requirements

### Requirement: Clients can submit a typed payroll event
The system SHALL expose `POST /events` accepting a JSON body of the form `{ "eventType": string, "payload": object }` for the supported event types `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, and `SALARY_CHANGE`. The endpoint SHALL require a valid access token and SHALL reject a request without one with HTTP `401`; the event SHALL be created inside the organization of the authenticated session. On success the system SHALL return HTTP `201` with `{ "id": <event id>, "status": "received" }`. Submissions with an unsupported `eventType` SHALL be rejected with HTTP `400`.

#### Scenario: Submit BANK_ACCOUNT_CHANGE
- **WHEN** an authenticated client POSTs `{ "eventType": "BANK_ACCOUNT_CHANGE", "payload": { "employeeId": "emp-1", "effectiveDate": "2026-09-01", "iban": "DE89370400440532013000" } }` to `/events` with a valid `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `201` with a body containing an `id` and `"status": "received"`

#### Scenario: Submit ADDRESS_CHANGE
- **WHEN** an authenticated client POSTs `{ "eventType": "ADDRESS_CHANGE", "payload": { "employeeId": "emp-2", "effectiveDate": "2026-09-01", "street": "Main St", "city": "Berlin", "postalCode": "10115", "country": "DE" } }` to `/events` with a valid `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `201` with a body containing an `id` and `"status": "received"`

#### Scenario: Submit SALARY_CHANGE
- **WHEN** an authenticated client POSTs `{ "eventType": "SALARY_CHANGE", "payload": { "employeeId": "emp-3", "effectiveDate": "2026-09-01", "newSalary": 75000, "currency": "EUR" } }` to `/events` with a valid `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `201` with a body containing an `id` and `"status": "received"`

#### Scenario: Submission without a token is rejected
- **WHEN** a client POSTs a valid event to `/events` with a valid `Idempotency-Key` but no `Authorization` header
- **THEN** the response SHALL be HTTP `401` and no event SHALL be persisted

#### Scenario: Event belongs to the caller's organization
- **WHEN** an authenticated client submits a valid event
- **THEN** the persisted event SHALL belong to the organization the client's access token is scoped to

#### Scenario: Unsupported event type
- **WHEN** a client POSTs `{ "eventType": "EXPENSE_REIMBURSEMENT", "payload": {} }` to `/events`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

### Requirement: Payloads are validated per event type

The system SHALL validate the `payload` against the field contract of its `eventType`:

- `BANK_ACCOUNT_CHANGE`: MUST include `employeeId` (string), `effectiveDate` (ISO date), and `iban` (IBAN format).
- `ADDRESS_CHANGE`: MUST include `employeeId`, `effectiveDate`, `street`, `city`, `postalCode`, and `country`.
- `SALARY_CHANGE`: MUST include `employeeId`, `effectiveDate`, `newSalary` (positive number), and `currency`.

Unknown fields in the payload SHALL be rejected, and any missing or malformed field SHALL result in HTTP `400` with a structured error body listing the failing fields.

In addition, the `employeeId` supplied in any supported payload SHALL reference an **active**
employee of the caller's organization's `employee-directory`: the check SHALL be made within the
submitting organization, so two organizations that use the same employee number remain
independent. A payload whose `employeeId` matches no directory employee in the caller's
organization — or whose matching employee is archived (`active = false`) — SHALL be rejected with
HTTP `422` and the structured error body, and no event SHALL be persisted. This is a business
validation (permanent) rejection: it SHALL be reported before the idempotency layer is consulted,
so a rejected attempt SHALL NOT consume, store, or replay against the request's `Idempotency-Key`
— after the organization registers (or reactivates) the employee, resubmitting with the same key
SHALL create a fresh event.

#### Scenario: Missing required field
- **WHEN** a client POSTs a `BANK_ACCOUNT_CHANGE` event whose `payload` omits `iban`
- **THEN** the response SHALL be HTTP `400` whose error body references `iban`, and no event SHALL be persisted

#### Scenario: Unknown field rejected
- **WHEN** a client POSTs a `SALARY_CHANGE` event whose `payload` contains an unrecognized field such as `"bonus": 1000`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

#### Scenario: Malformed field value
- **WHEN** a client POSTs a `SALARY_CHANGE` event whose `payload` has `"newSalary": "not-a-number"`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

#### Scenario: Event for an unknown employee is rejected
- **WHEN** an authenticated client POSTs a well-formed `SALARY_CHANGE` event whose `payload.employeeId` does not exist in their organization's directory
- **THEN** the response SHALL be HTTP `422` with a structured error body referencing `employeeId`, and no event SHALL be persisted

#### Scenario: Event for an archived employee is rejected
- **WHEN** a client submits an event for an `employeeId` whose directory employee has been archived
- **THEN** the response SHALL be HTTP `422` and no event SHALL be persisted

#### Scenario: Same employee number stays independent per organization
- **WHEN** organizations A and B both have an employee numbered `emp-001` in their directories
- **THEN** an event for `employeeId` `emp-001` submitted by organization A SHALL be accepted and ordered by A's sequence, and B's events for `emp-001` SHALL be unaffected

#### Scenario: A rejected submission does not consume the Idempotency-Key
- **WHEN** a client submits an event for an unknown `employeeId` with `Idempotency-Key` `k-1` (HTTP `422`), then registers that employee and resubmits the same event with `k-1`
- **THEN** the resubmission SHALL create a new event with HTTP `201` — it SHALL NOT replay the stored `422`

#### Scenario: Demo employee submissions remain accepted
- **WHEN** a client submits an event for a seeded `EMP-DEMO-*` employee of their organization
- **THEN** the submission SHALL pass the directory check and be persisted with HTTP `201`

### Requirement: Idempotency-Key is mandatory and dedupes submissions
The system SHALL require an `Idempotency-Key` header on `POST /events`; a request without it SHALL be rejected with HTTP `400`. Each event SHALL be persisted with its `idempotency_key` (`NOT NULL`) for traceability, and deduplication SHALL be enforced by the shared idempotency layer under the `event-submission` scope, keyed by `(organization, scope, key)` — the `UNIQUE (organization_id, scope, key)` constraint is the arbiter of idempotency. Keys SHALL therefore be deduplicated per organization: the same key value used by two organizations SHALL NOT dedupe across them. When a client resubmits with a previously-used key within the idempotency window (`IDEMPOTENCY_TTL_SECONDS`, default `86400` = 24 h), the system SHALL not create a second event; it SHALL return the stored response (`status` code and `body`) associated with the original submission. After the stored response for a key has expired, a submission with that key SHALL be treated as a new operation and a new event SHALL be created.

#### Scenario: Missing Idempotency-Key header
- **WHEN** a client POSTs a valid event to `/events` without an `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

#### Scenario: Duplicate submission returns the stored response
- **WHEN** a client POSTs a valid event with key `k-1`, then POSTs the same event again with key `k-1` within the idempotency window
- **THEN** the second response SHALL have the HTTP `201` status and the exact body returned by the first request, and only one event row SHALL exist for key `k-1`

#### Scenario: Concurrent duplicate submissions
- **WHEN** two identical requests with the same `Idempotency-Key` are submitted concurrently
- **THEN** exactly one event row SHALL be persisted for that key and both callers SHALL receive the stored response (a unique-constraint race SHALL be handled as a duplicate)

#### Scenario: Key reuse after expiry creates a new event
- **WHEN** a client POSTs an event with key `k-1`, the stored response for `k-1` expires, and the client POSTs an event again with key `k-1`
- **THEN** a new `payroll_events` row SHALL be created for key `k-1`, with its own `201` response and stored response

#### Scenario: The same key in two organizations dedupes independently
- **WHEN** organization A submits an event with key `k-1` and organization B submits a different event with the same key `k-1`
- **THEN** organization B's event SHALL be created with its own `201` stored response, and only one event row SHALL exist per organization for that key

### Requirement: Events are persisted with ordering and response columns
The system SHALL persist every accepted event as a `payroll_events` row containing `id`, `organization_id`, `event_type`, `employee_id`, `payload` (JSONB), a monotonic `sequence` per employee within that organization, `idempotency_key` (`NOT NULL`), `status` (`'received'` at submission, transitioning to `'queued'` immediately after the event is enqueued), and `created_at`/`updated_at` timestamps. The `UNIQUE(organization_id, employee_id, sequence)` constraint SHALL be enforced by the database; deduplication SHALL be enforced by the shared idempotency layer, not by `payroll_events`. The submission's stored response (HTTP `status` and `body`) SHALL be written by the shared idempotency layer into `idempotency_records` in the same transaction as the event row. The HTTP response for a submission SHALL always be `201` with a fixed body of `{ "id": <event id>, "status": "received" }`; the row's `status` transition to `'queued'` is queue-internal and SHALL NOT change the response contract.

#### Scenario: Row persisted with submission state
- **WHEN** a valid event is submitted
- **THEN** a `payroll_events` row SHALL exist with `organization_id`, `event_type`, `employee_id`, matching `payload`, `status = 'received'`, a non-null `id`, `sequence`, and `idempotency_key`; and an `idempotency_records` row SHALL exist under scope `event-submission` for that organization and key carrying the `201` stored response

#### Scenario: Row transitions to queued once enqueued
- **WHEN** a valid event is submitted and its enqueue step completes
- **THEN** the row's `status` SHALL be `'queued'`, while the `201` response body SHALL remain `{ "id": <event id>, "status": "received" }` and the stored response in `idempotency_records` SHALL remain unchanged

#### Scenario: Sequence increments per employee
- **WHEN** a client submits two events for the same `employeeId` sequentially
- **THEN** the second event's `sequence` SHALL equal the first event's `sequence` + 1

#### Scenario: Independent sequence per employee
- **WHEN** events are submitted for two different `employeeId` values within one organization
- **THEN** each employee's `sequence` SHALL start at 1 and increment independently of the other's counter

#### Scenario: Independent sequence per organization
- **WHEN** two organizations each submit their first event for the same `employeeId`
- **THEN** each organization's event SHALL have a `sequence` of 1
