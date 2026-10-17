# Spec Delta

## Purpose

Record what the pipeline actually does: every processing attempt that runs handler code leaves an
audit row — terminal rows atomically with their transition, transient rows best-effort outside the
aborted claim, and the final attempt's row idempotently righted at exhaustion.

## MODIFIED Requirements

### Requirement: Attempt outcomes are recorded in event_attempts
The system SHALL maintain an append-only `event_attempts` table recording EVERY processing
attempt that runs handler code, whether it ends in a terminal outcome or a transient retry. A
success SHALL record a row with `status` `SUCCESS` and the handler's `result`; a permanent
failure SHALL record a row with `status` `FAILED`, `errorType` `PERMANENT`, and `failedReason`;
each of those rows SHALL be created inside the same database transaction as the corresponding
`payroll_events` terminal transition. A transient failure SHALL record a row with `status`
`FAILED`, `errorType` `TEMPORARY`, and `failedReason`, written OUTSIDE the aborted claim
transaction (inside it, the row would roll back with the claim) and best-effort: a recording
failure SHALL be logged and swallowed and SHALL NEVER mask or replace the original transient
error that drives the retry. When retries are exhausted, the terminal `queued → failed`
transition SHALL commit atomically with the final attempt number's row via an idempotent upsert
— creating the row when no transient row exists (infrastructure-exhausted events), otherwise
updating only that existing row's `failedReason` to the terminal failure message; this is the
single permitted mutation in the table. The attempt trail therefore reads ascending and complete:
one row per attempt that ran, plus the exhaustion-authored final failure reason. Rows whose
attempt never ran handler code (stale or duplicate jobs, cancelled events, skipped claims) SHALL
NOT exist.

#### Scenario: Successful attempt records status and result
- **WHEN** an event reaches `success` on attempt N
- **THEN** an `event_attempts` row SHALL exist with `attemptNumber` N, `status` `SUCCESS`, and the same `result` stored on the event

#### Scenario: Permanent failure records error type and reason
- **WHEN** an event reaches `failed` due to a permanent handler error
- **THEN** an `event_attempts` row SHALL exist with `status` `FAILED`, `errorType` `PERMANENT`, and the failure reason

#### Scenario: Exhausted retries record a final failed attempt
- **WHEN** an event exhausts all retry attempts with transient failures
- **THEN** an `event_attempts` row SHALL exist with `status` `FAILED`, `errorType` `TEMPORARY`, and the final failure reason, committed atomically with the event's `queued → failed` transition

#### Scenario: Every transient attempt leaves a row
- **WHEN** an event's attempt fails transiently and is retried
- **THEN** a `FAILED`/`TEMPORARY` row for that attempt number SHALL exist after the failure, even though the event itself returned to `queued`

#### Scenario: Transient row write sits outside the aborted claim
- **WHEN** a transient failure aborts the claim transaction
- **THEN** the event SHALL be back in `queued` while its attempt row remains committed — proving the row was written by a separate, later transaction

#### Scenario: Attempt-row recording never masks the retry error
- **WHEN** recording the transient attempt row fails (for example a database hiccup) at the same moment the handler failed transiently
- **THEN** the original transient error SHALL still propagate to the queue (the retry SHALL happen), and the recording failure SHALL appear only in logs

#### Scenario: Exhaustion upserts the final attempt's row idempotently
- **WHEN** the last attempt fails transiently and its row already exists
- **THEN** the exhaustion transaction SHALL update that row's `failedReason` to the terminal failure message without creating a duplicate, and for an event exhausted without prior attempt rows the same key SHALL be created

#### Scenario: Skipped or stale jobs record nothing
- **WHEN** a duplicate or stale job observes the row as non-`queued` and applies no side effects
- **THEN** no `event_attempts` row SHALL be created for that job
