## ADDED Requirements

### Requirement: Clients can submit a typed payroll event

The system SHALL expose `POST /events` accepting a JSON body of the form `{ "eventType": string, "payload": object }` for the supported event types `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, and `SALARY_CHANGE`. On success the system SHALL return HTTP `201` with `{ "id": <event id>, "status": "received" }`. Submissions with an unsupported `eventType` SHALL be rejected with HTTP `400`.

#### Scenario: Submit BANK_ACCOUNT_CHANGE
- **WHEN** a client POSTs `{ "eventType": "BANK_ACCOUNT_CHANGE", "payload": { "employeeId": "emp-1", "effectiveDate": "2026-09-01", "iban": "DE89370400440532013000" } }` to `/events` with a valid `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `201` with a body containing an `id` and `"status": "received"`

#### Scenario: Submit ADDRESS_CHANGE
- **WHEN** a client POSTs `{ "eventType": "ADDRESS_CHANGE", "payload": { "employeeId": "emp-2", "effectiveDate": "2026-09-01", "street": "Main St", "city": "Berlin", "postalCode": "10115", "country": "DE" } }` to `/events` with a valid `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `201` with a body containing an `id` and `"status": "received"`

#### Scenario: Submit SALARY_CHANGE
- **WHEN** a client POSTs `{ "eventType": "SALARY_CHANGE", "payload": { "employeeId": "emp-3", "effectiveDate": "2026-09-01", "newSalary": 75000, "currency": "EUR" } }` to `/events` with a valid `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `201` with a body containing an `id` and `"status": "received"`

#### Scenario: Unsupported event type
- **WHEN** a client POSTs `{ "eventType": "EXPENSE_REIMBURSEMENT", "payload": {} }` to `/events`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

### Requirement: Payloads are validated per event type

The system SHALL validate the `payload` against the field contract of its `eventType`:

- `BANK_ACCOUNT_CHANGE`: MUST include `employeeId` (string), `effectiveDate` (ISO date), and `iban` (IBAN format).
- `ADDRESS_CHANGE`: MUST include `employeeId`, `effectiveDate`, `street`, `city`, `postalCode`, and `country`.
- `SALARY_CHANGE`: MUST include `employeeId`, `effectiveDate`, `newSalary` (positive number), and `currency`.

Unknown fields in the payload SHALL be rejected, and any missing or malformed field SHALL result in HTTP `400` with a structured error body listing the failing fields.

#### Scenario: Missing required field
- **WHEN** a client POSTs a `BANK_ACCOUNT_CHANGE` event whose `payload` omits `iban`
- **THEN** the response SHALL be HTTP `400` whose error body references `iban`, and no event SHALL be persisted

#### Scenario: Unknown field rejected
- **WHEN** a client POSTs a `SALARY_CHANGE` event whose `payload` contains an unrecognized field such as `"bonus": 1000`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

#### Scenario: Malformed field value
- **WHEN** a client POSTs a `SALARY_CHANGE` event whose `payload` has `"newSalary": "not-a-number"`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

### Requirement: Idempotency-Key is mandatory and dedupes submissions

The system SHALL require an `Idempotency-Key` header on `POST /events`; a request without it SHALL be rejected with HTTP `400`. Each event SHALL be persisted with its `idempotency_key` enforced as `NOT NULL` and `UNIQUE`. When a client resubmits with a previously-used key, the system SHALL not create a second event; it SHALL return the stored response (`status` code and `body`) associated with the original submission.

#### Scenario: Missing Idempotency-Key header
- **WHEN** a client POSTs a valid event to `/events` without an `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

#### Scenario: Duplicate submission returns the stored response
- **WHEN** a client POSTs a valid event with key `k-1`, then POSTs the same event again with key `k-1`
- **THEN** the second response SHALL have the HTTP `201` status and the exact body returned by the first request, and only one event row SHALL exist for key `k-1`

#### Scenario: Concurrent duplicate submissions
- **WHEN** two identical requests with the same `Idempotency-Key` are submitted concurrently
- **THEN** exactly one event row SHALL be persisted for that key and both callers SHALL receive the stored response (a unique-constraint race SHALL be handled as a duplicate)

### Requirement: Events are persisted with ordering and response columns

The system SHALL persist every accepted event as a `payroll_events` row containing `id`, `event_type`, `employee_id`, `payload` (JSONB), a per-employee monotonic `sequence`, `idempotency_key`, `status` (`'received'` at submission), `response_status` and `response_body` (written in the same transaction), and `created_at`/`updated_at` timestamps. The `UNIQUE(idempotency_key)` and `UNIQUE(employee_id, sequence)` constraints SHALL be enforced by the database.

#### Scenario: Row persisted with submission state
- **WHEN** a valid event is submitted
- **THEN** a `payroll_events` row SHALL exist with `event_type`, `employee_id`, matching `payload`, `status = 'received'`, a non-null `id` and `sequence`, and `response_status`/`response_body` populated

#### Scenario: Sequence increments per employee
- **WHEN** a client submits two events for the same `employeeId` sequentially
- **THEN** the second event's `sequence` SHALL equal the first event's `sequence` + 1

#### Scenario: Independent sequence per employee
- **WHEN** events are submitted for two different `employeeId` values
- **THEN** each employee's `sequence` SHALL start at 1 and increment independently of the other's counter