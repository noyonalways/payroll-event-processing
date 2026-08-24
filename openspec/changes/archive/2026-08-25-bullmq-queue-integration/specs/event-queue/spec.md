## ADDED Requirements

### Requirement: Queue infrastructure is wired to Redis
The system SHALL provide a BullMQ queue named `payroll-events` whose connection uses the environment-provided Redis host and port (`REDIS_HOST`, `REDIS_PORT`). The producer and the worker SHALL use the same queue name and connection settings.

#### Scenario: Queue connects with configured Redis
- **WHEN** the API or worker application starts with `REDIS_HOST` and `REDIS_PORT` set
- **THEN** the queue SHALL be registered against those settings and jobs SHALL be addable and processed against that Redis instance

### Requirement: Per-employee FIFO with parallelism across employees
The system SHALL add jobs to the queue with `jobId` equal to the event's `employeeId`, so that at most one job for a given employee exists in the queue at a time. Different employees' jobs SHALL be eligible for processing in parallel. Event ordering within an employee SHALL follow the persisted per-employee `sequence`.

#### Scenario: Only one in-flight job per employee
- **WHEN** multiple events for the same `employeeId` are submitted in quick succession
- **THEN** at most one queue job for that `employeeId` SHALL be in flight at any time across all workers

#### Scenario: Different employees process concurrently
- **WHEN** jobs for two distinct `employeeId` values are present in the queue
- **THEN** they SHALL be processable concurrently rather than serially

#### Scenario: Same-employee events are processed in sequence order
- **WHEN** an employee has multiple events awaiting processing with different `sequence` values
- **THEN** the worker SHALL claim and complete them in ascending `sequence` order

### Requirement: Accepted events are enqueued without blocking the response
The system SHALL enqueue a queue job for each accepted event immediately after its `payroll_events` row has been committed by the submission transaction. The enqueue operation SHALL be best-effort: it SHALL NOT block the HTTP response and SHALL NOT cause the submission to fail or return an error. The event row SHALL transition from `received` to `queued` when the event is enqueued; the HTTP response SHALL remain `201` with `{ "id": <event id>, "status": "received" }` regardless of queue state.

#### Scenario: Enqueue happens after persist
- **WHEN** a valid event is submitted
- **THEN** after the `payroll_events` row is committed, a job for that event SHALL be added to `payroll-events`, and the response SHALL still be HTTP `201`
- **AND** the row's `status` SHALL be `queued` once the event is enqueued

#### Scenario: Queue unavailable does not fail the submission
- **WHEN** a valid event is submitted while Redis is unreachable
- **THEN** the response SHALL still be HTTP `201` with `{ "id": <event id>, "status": "received" }`, the row SHALL be persisted, and no exception SHALL surface to the caller

### Requirement: Worker claims and completes jobs with guarded transitions
The worker SHALL claim a job by transitioning its event row from `queued` to `processing` with a guarded update (only when the row is currently `queued`). It SHALL emit a structured log line per job recording `eventId`, `employeeId`, `eventType`, `sequence`, attempt, and worker identity. When the processing step completes, the worker SHALL transition the row from `processing` to `success` and set `processed_at` with a guarded update. A job whose row cannot be claimed (not in `queued` state) SHALL be logged and skipped without any further side effects.

#### Scenario: Job is claimed and completed
- **WHEN** the worker processes a job for a row in `queued` state
- **THEN** the row SHALL transition `queued → processing`, be logged, then transition `processing → success` with a non-null `processed_at`

#### Scenario: Stale or duplicate job is skipped
- **WHEN** the worker processes a job whose event row is not in `queued` state (for example already `processing` or `success`)
- **THEN** the worker SHALL log the event and SHALL apply no further state change or side effect

### Requirement: FIFO recovery relay prevents lost events
When the worker finishes a job for an employee and another non-terminal event (row state `received` or `queued`, with a higher `sequence`) exists for the same employee, the worker SHALL schedule that next event for processing using the employee's `jobId`. If a queue job for that employee already exists, the schedule SHALL be a no-op and SHALL NOT create a duplicate job. This ensures no submission is dropped when the submission-time enqueue is suppressed by an in-flight job for the same employee.

#### Scenario: Burst submissions are drained sequentially
- **WHEN** several events for one employee are submitted while an earlier job for that employee is still in flight
- **THEN** after each job completes the worker SHALL relay the next pending event for that employee until none remain, and every event SHALL eventually reach a terminal state

#### Scenario: Relay does not duplicate jobs
- **WHEN** the worker's relay attempts to schedule the next event for an employee and a job for that employee is already present in the queue
- **THEN** the schedule SHALL not add a second job

### Requirement: Queue non-availability does not lose events
An event whose enqueue was suppressed or failed SHALL remain recoverable from its persisted row. The system SHALL never depend on the queue's retained job history as the record of which events await processing; the `payroll_events` row (`status` and `sequence`) SHALL be the source of truth for pending work.

#### Scenario: Pending events are recovered from the database
- **WHEN** the worker completes a job and finds rows for the same employee in non-terminal state that were not enqueued themselves
- **THEN** the worker SHALL schedule them for processing from their row state alone, with no reliance on prior Redis job data