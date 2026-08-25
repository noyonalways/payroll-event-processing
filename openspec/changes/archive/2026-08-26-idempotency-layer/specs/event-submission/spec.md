## MODIFIED Requirements

### Requirement: Idempotency-Key is mandatory and dedupes submissions
The system SHALL require an `Idempotency-Key` header on `POST /events`; a request without it SHALL be rejected with HTTP `400`. Each event SHALL be persisted with its `idempotency_key` (`NOT NULL`) for traceability, and deduplication SHALL be enforced by the shared idempotency layer: the `UNIQUE (scope, key)` constraint on the `idempotency_records` store is the arbiter of idempotency, used under the `event-submission` scope. When a client resubmits with a previously-used key within the idempotency window (`IDEMPOTENCY_TTL_SECONDS`, default `86400` = 24 h), the system SHALL not create a second event; it SHALL return the stored response (`status` code and `body`) associated with the original submission. After the stored response for a key has expired, a submission with that key SHALL be treated as a new operation and a new event SHALL be created.

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

### Requirement: Events are persisted with ordering and response columns
The system SHALL persist every accepted event as a `payroll_events` row containing `id`, `event_type`, `employee_id`, `payload` (JSONB), a per-employee monotonic `sequence`, `idempotency_key` (`NOT NULL`), `status` (`'received'` at submission, transitioning to `'queued'` immediately after the event is enqueued), and `created_at`/`updated_at` timestamps. The `UNIQUE(employee_id, sequence)` constraint SHALL be enforced by the database; deduplication SHALL be enforced by the shared idempotency layer, not by `payroll_events`. The submission's stored response (HTTP `status` and `body`) SHALL be written by the shared idempotency layer into `idempotency_records` in the same transaction as the event row. The HTTP response for a submission SHALL always be `201` with a fixed body of `{ "id": <event id>, "status": "received" }`; the row's `status` transition to `'queued'` is queue-internal and SHALL NOT change the response contract.

#### Scenario: Row persisted with submission state
- **WHEN** a valid event is submitted
- **THEN** a `payroll_events` row SHALL exist with `event_type`, `employee_id`, matching `payload`, `status = 'received'`, a non-null `id`, `sequence`, and `idempotency_key`; and an `idempotency_records` row SHALL exist under scope `event-submission` carrying the `201` stored response for that key

#### Scenario: Row transitions to queued once enqueued
- **WHEN** a valid event is submitted and its enqueue step completes
- **THEN** the row's `status` SHALL be `'queued'`, while the `201` response body SHALL remain `{ "id": <event id>, "status": "received" }` and the stored response in `idempotency_records` SHALL remain unchanged

#### Scenario: Sequence increments per employee
- **WHEN** a client submits two events for the same `employeeId` sequentially
- **THEN** the second event's `sequence` SHALL equal the first event's `sequence` + 1

#### Scenario: Independent sequence per employee
- **WHEN** events are submitted for two different `employeeId` values
- **THEN** each employee's `sequence` SHALL start at 1 and increment independently of the other's counter