# Event Queue

## Purpose

Provide a BullMQ-backed `payroll-events` queue that transports accepted payroll events from the submission API to the worker for background processing. The queue enforces per-employee FIFO ordering (at most one in-flight job per employee) while allowing parallelism across employees, and treats the persisted `payroll_events` row (`status` and `sequence`) as the source of truth so queue non-availability never causes an event to be lost.

## Requirements

### Requirement: Queue infrastructure is wired to Redis
The system SHALL provide a BullMQ queue named `payroll-events` whose connection uses the environment-provided Redis host and port (`REDIS_HOST`, `REDIS_PORT`). The producer and the worker SHALL use the same queue name and connection settings.

#### Scenario: Queue connects with configured Redis
- **WHEN** the API or worker application starts with `REDIS_HOST` and `REDIS_PORT` set
- **THEN** the queue SHALL be registered against those settings and jobs SHALL be addable and processed against that Redis instance

### Requirement: Per-employee FIFO with parallelism across employees
The system SHALL add jobs to the queue with a tenant-qualified `jobId` derived from the event's organization and its `employeeId`, so that at most one job for a given employee within a given organization exists in the queue at a time. The identifier SHALL be distinct for every (organization, employee) pair — no two pairs may map onto the same value, or a submission's job would be silently suppressed — and SHALL be a value the queue accepts as a custom id (in particular it SHALL NOT contain a colon, which the queue rejects unless the value splits into exactly three segments). Because the organization participates in the job id, two organizations that use the same `employeeId` SHALL NOT share a queue slot and SHALL NOT wait on each other's in-flight work. Different employees' jobs SHALL be eligible for processing in parallel. Event ordering within an employee SHALL follow the persisted per-employee `sequence`, which is itself scoped to the organization.

#### Scenario: Only one in-flight job per employee
- **WHEN** multiple events for the same `employeeId` in the same organization are submitted in quick succession
- **THEN** at most one queue job for that organization and `employeeId` SHALL be in flight at any time across all workers
- **AND** the job data SHALL carry the organization the event belongs to

#### Scenario: Different employees process concurrently
- **WHEN** jobs for two distinct `employeeId` values are present in the queue
- **THEN** they SHALL be processable concurrently rather than serially

#### Scenario: The same employee id in two organizations does not share a job
- **WHEN** organization A and organization B each have a pending event for `employeeId` `emp-1`
- **THEN** each SHALL occupy its own queue slot and SHALL be eligible for processing concurrently, rather than one suppressing or delaying the other

#### Scenario: Same-employee events are processed in sequence order
- **WHEN** an employee has multiple events awaiting processing with different `sequence` values within one organization
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
The worker SHALL claim a job by transitioning its event row from `queued` to `processing` with a guarded update (only when the row is currently `queued`), where the claim, the handler dispatch, and the terminal transition SHALL all execute inside a single database transaction. A job whose row cannot be claimed (not in `queued` state) SHALL be logged and skipped without any further side effects. Once claimed, the worker SHALL dispatch the event to its handler via the processing handler strategy registry. When the handler returns a success result, the worker SHALL store that result in the event row's `result` column and SHALL transition the row from `processing` to `success` and set `processed_at` with a guarded update (only when the row is currently `processing`), committed together with the claim. When the handler fails permanently, the worker SHALL transition the row from `processing` to `failed` with a guarded update, SHALL NOT store a success result, and SHALL NOT re-enqueue the job. When the handler fails transiently, the transaction SHALL abort and the claim SHALL roll back to `queued` so a retry can claim it again. A crash or lost connection at any point before commit SHALL also roll back the claim, leaving the row in `queued` and reprocessable rather than stuck in `processing`. The worker SHALL emit structured log lines for the processing stage (`started`, `succeeded`, `retrying`, `permanent-failure`) recording `eventId`, `employeeId`, `eventType`, `sequence`, attempt, and worker identity.

#### Scenario: Job is claimed, processed, and completes with a stored result
- **WHEN** the worker processes a job for a row in `queued` state and the handler succeeds
- **THEN** the row SHALL transition `queued → processing`, the `started` log line SHALL be emitted, the handler SHALL be invoked, the `result` column SHALL be set to the handler's result, the row SHALL transition `processing → success` with a non-null `processed_at`, and a `succeeded` log line SHALL be emitted

#### Scenario: Handler failure transitions the row to failed
- **WHEN** the worker processes a job for a row in `queued` state and the handler fails permanently
- **THEN** the row SHALL transition `queued → processing`, then `processing → failed`, the `result` column SHALL be NULL, `processed_at` SHALL be NULL, a `permanent-failure` log line SHALL be emitted, and the job SHALL NOT be re-enqueued

#### Scenario: Stale or duplicate job is skipped
- **WHEN** the worker processes a job whose event row is not in `queued` state (for example already `processing` or `success`)
- **THEN** the worker SHALL log the event and SHALL apply no further state change or side effect, including no handler invocation

#### Scenario: Crash during processing rolls back the claim
- **WHEN** a worker process dies after its event row was transitioned to `processing` but before the terminal transition commits
- **THEN** the transaction SHALL abort and the row SHALL be `queued` again, so a later attempt SHALL be able to claim and complete it without manual intervention

### Requirement: FIFO recovery relay prevents lost events
When the worker finishes a job for an employee and another non-terminal event (row state `received` or `queued`, with a higher `sequence`) exists for the same employee **in the same organization**, the worker SHALL schedule that next event for processing using the same tenant-qualified `jobId`. The lookup SHALL be constrained to the organization carried by the completed job, so a completion in one organization SHALL never schedule another organization's event. If a queue job for that organization and employee already exists, the schedule SHALL be a no-op and SHALL NOT create a duplicate job. This ensures no submission is dropped when the submission-time enqueue is suppressed by an in-flight job for the same employee.

#### Scenario: Burst submissions are drained sequentially
- **WHEN** several events for one employee are submitted while an earlier job for that employee is still in flight
- **THEN** after each job completes the worker SHALL relay the next pending event for that employee until none remain, and every event SHALL eventually reach a terminal state

#### Scenario: Relay does not duplicate jobs
- **WHEN** the worker's relay attempts to schedule the next event for an employee and a job for that organization and employee is already present in the queue
- **THEN** the schedule SHALL not add a second job

#### Scenario: Relay does not cross organizations
- **WHEN** the worker completes a job for `emp-1` in organization A, and organization B also has a pending event for `emp-1`
- **THEN** the relay SHALL select only organization A's next pending event and SHALL NOT schedule organization B's event

### Requirement: Queue non-availability does not lose events
An event whose enqueue was suppressed or failed SHALL remain recoverable from its persisted row. The system SHALL never depend on the queue's retained job history as the record of which events await processing; the `payroll_events` row (`status` and `sequence`) SHALL be the source of truth for pending work, evaluated within the event's organization.

#### Scenario: Pending events are recovered from the database
- **WHEN** the worker completes a job and finds rows for the same employee and organization in non-terminal state that were not enqueued themselves
- **THEN** the worker SHALL schedule them for processing from their row state alone, with no reliance on prior Redis job data

### Requirement: Stalled jobs are re-queued with explicit worker recovery settings
The system SHALL configure the BullMQ worker's stalled-job recovery with environment-configurable settings: `PAYROLL_WORKER_LOCK_DURATION_MS` (default 30000), `PAYROLL_WORKER_STALLED_INTERVAL_MS` (default 30000), and `PAYROLL_WORKER_MAX_STALLED_COUNT` (default 1). A job whose worker fails to renew its lock within the lock duration SHALL be detected as stalled and SHALL be re-queued for processing up to `PAYROLL_WORKER_MAX_STALLED_COUNT` times. Because a crashed processing transaction rolls back its claim, a re-queued job SHALL find the event row claimable (`queued`) and SHALL complete it, and the event SHALL reach a terminal state.

#### Scenario: Dead worker job is re-queued and reprocessed
- **WHEN** a worker dies mid-job and the job is subsequently detected as stalled
- **THEN** the job SHALL be re-queued, a fresh worker SHALL claim its event row from `queued`, and the event SHALL reach `success` or `failed`

#### Scenario: Stalled job is not re-queued past the max count
- **WHEN** a job is detected as stalled `PAYROLL_WORKER_MAX_STALLED_COUNT` times
- **THEN** BullMQ SHALL NOT re-queue the job again and SHALL mark it as failed
