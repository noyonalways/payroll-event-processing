## MODIFIED Requirements

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
