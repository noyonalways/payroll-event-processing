## MODIFIED Requirements

### Requirement: Events are persisted with ordering and response columns
The system SHALL persist every accepted event as a `payroll_events` row containing `id`, `event_type`, `employee_id`, `payload` (JSONB), a per-employee monotonic `sequence`, `idempotency_key`, `status` (`'received'` at submission, transitioning to `'queued'` immediately after the event is enqueued), `response_status` and `response_body` (written in the same transaction), and `created_at`/`updated_at` timestamps. The `UNIQUE(idempotency_key)` and `UNIQUE(employee_id, sequence)` constraints SHALL be enforced by the database. The HTTP response for a submission SHALL always be `201` with a fixed body of `{ "id": <event id>, "status": "received" }`; the row's `status` transition to `'queued'` is queue-internal and SHALL NOT change the response contract.

#### Scenario: Row persisted with submission state
- **WHEN** a valid event is submitted
- **THEN** a `payroll_events` row SHALL exist with `event_type`, `employee_id`, matching `payload`, `status = 'received'`, a non-null `id` and `sequence`, and `response_status`/`response_body` populated

#### Scenario: Row transitions to queued once enqueued
- **WHEN** a valid event is submitted and its enqueue step completes
- **THEN** the row's `status` SHALL be `'queued'`, while the `201` response body SHALL remain `{ "id": <event id>, "status": "received" }` and `response_status`/`response_body` SHALL remain unchanged

#### Scenario: Sequence increments per employee
- **WHEN** a client submits two events for the same `employeeId` sequentially
- **THEN** the second event's `sequence` SHALL equal the first event's `sequence` + 1

#### Scenario: Independent sequence per employee
- **WHEN** events are submitted for two different `employeeId` values
- **THEN** each employee's `sequence` SHALL start at 1 and increment independently of the other's counter