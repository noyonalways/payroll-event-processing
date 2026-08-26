## ADDED Requirements

### Requirement: Stalled jobs are re-queued with explicit worker recovery settings
The system SHALL configure the BullMQ worker's stalled-job recovery with environment-configurable settings: `PAYROLL_WORKER_LOCK_DURATION_MS` (default 30000), `PAYROLL_WORKER_STALLED_INTERVAL_MS` (default 30000), and `PAYROLL_WORKER_MAX_STALLED_COUNT` (default 1). A job whose worker fails to renew its lock within the lock duration SHALL be detected as stalled and SHALL be re-queued for processing up to `PAYROLL_WORKER_MAX_STALLED_COUNT` times. Because a crashed processing transaction rolls back its claim, a re-queued job SHALL find the event row claimable (`queued`) and SHALL complete it, and the event SHALL reach a terminal state.

#### Scenario: Dead worker job is re-queued and reprocessed
- **WHEN** a worker dies mid-job and the job is subsequently detected as stalled
- **THEN** the job SHALL be re-queued, a fresh worker SHALL claim its event row from `queued`, and the event SHALL reach `success` or `failed`

#### Scenario: Stalled job is not re-queued past the max count
- **WHEN** a job is detected as stalled `PAYROLL_WORKER_MAX_STALLED_COUNT` times
- **THEN** BullMQ SHALL NOT re-queue the job again and SHALL mark it as failed

## MODIFIED Requirements

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