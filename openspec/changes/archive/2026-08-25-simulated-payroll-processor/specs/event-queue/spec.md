## MODIFIED Requirements

### Requirement: Worker claims and completes jobs with guarded transitions
The worker SHALL claim a job by transitioning its event row from `queued` to `processing` with a guarded update (only when the row is currently `queued`). A job whose row cannot be claimed (not in `queued` state) SHALL be logged and skipped without any further side effects. Once claimed, the worker SHALL dispatch the event to its handler via the processing handler strategy registry. When the handler returns a success result, the worker SHALL store that result in the event row's `result` column and SHALL transition the row from `processing` to `success` and set `processed_at`, both with guarded updates (only when the row is currently `processing`). When the handler fails, the worker SHALL transition the row from `processing` to `failed` with a guarded update, SHALL NOT store a success result, and SHALL NOT re-enqueue the job. The worker SHALL emit structured log lines for the processing stage (`started`, `succeeded`, `failed`) recording `eventId`, `employeeId`, `eventType`, `sequence`, attempt, and worker identity.

#### Scenario: Job is claimed, processed, and completes with a stored result
- **WHEN** the worker processes a job for a row in `queued` state and the handler succeeds
- **THEN** the row SHALL transition `queued → processing`, the `started` log line SHALL be emitted, the handler SHALL be invoked, the `result` column SHALL be set to the handler's result, the row SHALL transition `processing → success` with a non-null `processed_at`, and a `succeeded` log line SHALL be emitted

#### Scenario: Handler failure transitions the row to failed
- **WHEN** the worker processes a job for a row in `queued` state and the handler fails
- **THEN** the row SHALL transition `queued → processing`, then `processing → failed`, the `result` column SHALL be NULL, `processed_at` SHALL be NULL, a `failed` log line SHALL be emitted, and the job SHALL NOT be re-enqueued

#### Scenario: Stale or duplicate job is skipped
- **WHEN** the worker processes a job whose event row is not in `queued` state (for example already `processing` or `success`)
- **THEN** the worker SHALL log the event and SHALL apply no further state change or side effect, including no handler invocation