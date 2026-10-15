# Spec Delta

## MODIFIED Requirements

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
