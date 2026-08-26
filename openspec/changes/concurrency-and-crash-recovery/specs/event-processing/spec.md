## ADDED Requirements

### Requirement: Worker processes each event transactionally with a row lock
The worker SHALL process an event inside a single database transaction that SHALL take a row lock (`SELECT … FOR UPDATE`) on the event row before claiming it, SHALL transition the row `queued → processing` with a guarded update (only when the row is currently `queued`), SHALL read the event payload, SHALL dispatch the event to its handler, and SHALL commit the terminal transition together with the claim. The row lock SHALL ensure that even when multiple worker instances race, only one worker processes a given event at a time; a contender that finds the row already claimed or terminal SHALL apply no side effects. When the handler throws a transient failure, the transaction SHALL abort and the claim SHALL roll back to `queued`. When the handler fails permanently, the terminal `processing → failed` transition SHALL commit. A crash or connection loss before commit SHALL leave the row claimable in `queued`, never stuck in `processing`.

#### Scenario: Success commits the claim and terminal write atomically
- **WHEN** the worker processes a job whose handler succeeds
- **THEN** the row SHALL reach `success` with `result` and `processed_at` set, and the `processing` claim SHALL have been committed in the same transaction as the terminal transition

#### Scenario: Transient failure aborts and returns the row to queued
- **WHEN** the worker processes a job whose handler throws a transient failure
- **THEN** the transaction SHALL abort, the row SHALL be `queued` again (no `processing` residue), and the job SHALL be retried by the queue

#### Scenario: Crash before commit leaves the row claimable
- **WHEN** the worker process is killed after the claim but before the terminal transition commits
- **THEN** the claim SHALL be rolled back and the row SHALL remain `queued`, claimable by a later attempt

#### Scenario: Concurrent worker on the same event is a no-op
- **WHEN** two workers attempt to claim the same event row
- **THEN** exactly one SHALL commit a `queued → processing` transition and the other SHALL observe the row as no longer `queued` and SHALL apply no side effects

### Requirement: Attempt outcomes are recorded in event_attempts
The system SHALL maintain an append-only `event_attempts` table recording every attempt that commits a terminal outcome: a success SHALL record a row with `status` `SUCCESS` and the handler's `result`; a permanent or exhausted failure SHALL record a row with `status` `FAILED`, `errorType` (`PERMANENT` or `TEMPORARY`), and `failedReason`. Each such row SHALL be created in the same database transaction as the `payroll_events` terminal transition. Transient attempts that are retried SHALL NOT create rows in `event_attempts` (they remain observable through structured `retrying` log lines). The table SHALL be append-only: rows SHALL never be updated or deleted after creation.

#### Scenario: Successful attempt records status and result
- **WHEN** an event reaches `success` on attempt N
- **THEN** an `event_attempts` row SHALL exist with `attemptNumber` N, `status` `SUCCESS`, and the same `result` stored on the event

#### Scenario: Permanent failure records error type and reason
- **WHEN** an event reaches `failed` due to a permanent handler error
- **THEN** an `event_attempts` row SHALL exist with `status` `FAILED`, `errorType` `PERMANENT`, and the failure reason

#### Scenario: Exhausted retries record a final failed attempt
- **WHEN** an event exhausts all retry attempts with transient failures
- **THEN** an `event_attempts` row SHALL exist with `status` `FAILED`, `errorType` `TEMPORARY`, and the final failure reason, committed atomically with the event's `queued → failed` transition