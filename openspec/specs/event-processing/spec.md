# Event Processing

## Purpose

Provide the in-process simulated payroll processing pipeline. A handler strategy registry keyed by `EventType` dispatches each payroll event to a dedicated handler that runs the simulated external operation and returns a typed result describing the applied change. A simulated external provider with configurable transient/permanent failure rates exercises retry and failure handling, and structured lifecycle logging records each processing stage with full event context.

## Requirements

### Requirement: Handler strategy registry resolves a processor per event type
The system SHALL provide a handler strategy registry keyed by `EventType` that resolves a processor for each supported event type: `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, and `SALARY_CHANGE`. Adding a new event type SHALL require only a new registry entry (plus the event type and its payload DTO) — no worker or controller changes. Resolving an event type that has no registered handler SHALL raise an error so misconfiguration fails fast rather than silently skipping processing.

#### Scenario: Every supported event type resolves a handler
- **WHEN** the registry is asked for a handler for `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, and `SALARY_CHANGE`
- **THEN** a distinct handler SHALL be returned for each type

#### Scenario: Unregistered event type fails fast
- **WHEN** the registry is asked for a handler for an event type with no registration
- **THEN** the registry SHALL raise an error identifying the unknown type

### Requirement: Each handler returns a typed simulated processing result

Each handler SHALL run the external payroll operation for its event type through the provider
resolved for the event's organization (HTTP adapter when the organization has an active
configuration, the simulated provider otherwise) and, on success, SHALL return a result object
that describes the applied change. The result SHALL identify the external operation (a
reference string — provider-supplied, simulated-generated for the default), the employee, the
effective date, and the affected fields with their new values. The result shape SHALL be
permitted to differ per event type, but SHALL NOT depend on which provider ran.

#### Scenario: Bank account change produces a result
- **WHEN** the `BANK_ACCOUNT_CHANGE` handler processes an event for employee `emp-1` with `iban` `DE89370400440532013000`
- **THEN** it SHALL return a success result whose reference is non-empty and whose affected-field payload acknowledges the `iban` value `DE89370400440532013000`

#### Scenario: Salary change produces a result
- **WHEN** the `SALARY_CHANGE` handler processes an event for employee `emp-3` with `newSalary` `75000`
- **THEN** it SHALL return a success result whose reference is non-empty and whose affected-field payload acknowledges `newSalary` `75000`

#### Scenario: Address change produces a result
- **WHEN** the `ADDRESS_CHANGE` handler processes an event for employee `emp-2`
- **THEN** it SHALL return a success result whose reference is non-empty and whose affected-field payload acknowledges the supplied address fields

#### Scenario: Result shape is provider-independent
- **WHEN** the same event is processed once with the simulated provider and once with the HTTP adapter (both succeeding)
- **THEN** the result SHALL differ at most in the reference value, with the employee, effective date, and affected fields identical

### Requirement: Simulated provider fails transiently or permanently at configurable rates

The system SHALL provide a simulated external payroll provider as the DEFAULT provider for
organizations without an active HTTP configuration, that succeeds or fails according to
configurable rates: `PAYROLL_TEMPORARY_FAILURE_RATE` (probability of a transient failure, default
0.25) and `PAYROLL_PERMANENT_FAILURE_RATE` (probability of a permanent failure, default 0.05).
Transient failures SHALL be distinguishable from permanent failures (distinct error classes). A
transient failure SHALL be a failure that could succeed on retry; a permanent failure SHALL be a
business-level failure that retrying would not fix. Both classes SHALL be the same classes the
HTTP adapter raises, so retry semantics are provider-independent.

#### Scenario: Always-succeed override returns a result
- **WHEN** the provider is configured with the always-succeed override and invoked
- **THEN** it SHALL return a success result and SHALL NOT throw

#### Scenario: Always-transient override throws a transient error
- **WHEN** the provider is configured with the always-transient override and invoked
- **THEN** it SHALL throw an error of the transient failure class

#### Scenario: Always-permanent override throws a permanent error
- **WHEN** the provider is configured with the always-permanent override and invoked
- **THEN** it SHALL throw an error of the permanent failure class

#### Scenario: Zero failure rates always succeed
- **WHEN** both `PAYROLL_TEMPORARY_FAILURE_RATE` and `PAYROLL_PERMANENT_FAILURE_RATE` are `0` and the provider is invoked repeatedly
- **THEN** every invocation SHALL succeed

### Requirement: Processing lifecycle is logged with structured context
The system SHALL emit structured log lines for each processing lifecycle stage: `started` (immediately before the handler runs), `succeeded` (handler returned a result), `retrying` (transient failure, attempt N will be retried), `permanent-failure` (permanent or unknown error, no retry), and `exhausted` (all retry attempts consumed). Each log line SHALL include `eventId`, `employeeId`, `eventType`, `sequence`, attempt number, and worker identity. The `retrying` log line SHALL additionally include the max attempt count. The `permanent-failure` and `exhausted` log lines SHALL additionally include the failure message.

#### Scenario: Successful processing logs started then succeeded
- **WHEN** a handler completes successfully
- **THEN** the worker SHALL have logged a `started` line before the handler call and a `succeeded` line after, both carrying the event context fields

#### Scenario: Transient failure logs retrying
- **WHEN** a handler throws a `TransientPayrollFailureError` and attempts remain
- **THEN** the worker SHALL log a `retrying` line carrying the event context fields, the current attempt number, and the max attempt count

#### Scenario: Permanent failure logs permanent-failure
- **WHEN** a handler throws a `PermanentPayrollFailureError` or unknown error
- **THEN** the worker SHALL log a `permanent-failure` line carrying the event context fields and the failure message

#### Scenario: Exhausted retries logs exhausted
- **WHEN** BullMQ exhausts all retry attempts for a job
- **THEN** the worker SHALL log an `exhausted` line carrying the event context fields and the failure message

### Requirement: Worker processes each event transactionally with a row lock

The worker SHALL process an event inside a single database transaction that SHALL take a row lock
(`SELECT … FOR UPDATE`) on the event row before claiming it, SHALL transition the row `queued →
processing` with a guarded update (only when the row is currently `queued`), SHALL read the event
payload, SHALL dispatch the event to its handler, and SHALL commit the terminal transition
together with the claim. Every statement in that transaction SHALL be scoped by the event's
organization in addition to the event identifier, so a job naming a valid event of another
organization SHALL claim and mutate nothing. The row lock SHALL ensure that even when multiple
worker instances race, only one worker processes a given event at a time; a contender that finds
the row already claimed or terminal SHALL apply no side effects. When the handler throws a
transient failure, the transaction SHALL abort and the claim SHALL roll back to `queued`. When
the handler fails permanently, the terminal `processing → failed` transition SHALL commit. A
crash or connection loss before commit SHALL leave the row claimable in `queued`, never stuck in
`processing`. When the organization has at least one active webhook endpoint, the transaction
SHALL additionally create a pending webhook delivery intent for the committed terminal state;
the intent SHALL commit atomically with the terminal transition, and webhook delivery shall never
delay, fail, or roll back the event's own commit.

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

#### Scenario: A job naming a foreign organization's event changes nothing
- **WHEN** the worker processes a job whose event id exists but belongs to a different organization than the job carries
- **THEN** the claim SHALL match no row, the event SHALL be left untouched, and no attempt SHALL be recorded against it

#### Scenario: Terminal commit writes its delivery intent atomically
- **WHEN** the worker commits a terminal transition for an event in an organization with at least one active webhook endpoint
- **THEN** the same transaction SHALL persist a pending delivery intent per active endpoint, and no intent SHALL exist when the transaction aborts

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

