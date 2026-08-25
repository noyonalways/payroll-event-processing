## ADDED Requirements

### Requirement: Transient failures are retried with exponential backoff
The system SHALL configure BullMQ jobs with a maximum attempt count controlled by `PAYROLL_MAX_RETRY_ATTEMPTS` (default `5`) and an exponential backoff delay whose base is controlled by `PAYROLL_RETRY_BASE_DELAY_MS` (default `1000` ms). When a `TransientPayrollFailureError` is thrown during processing, the worker SHALL reset the event row from `processing` to `queued` and SHALL re-throw the error so BullMQ schedules the next attempt at the computed backoff delay.

#### Scenario: Transient failure triggers retry and row reset
- **WHEN** the handler throws a `TransientPayrollFailureError` on attempt N (where N < max attempts)
- **THEN** the event row SHALL be reset to `queued` status
- **AND** the `process()` method SHALL re-throw the error so BullMQ schedules attempt N+1 with exponential backoff

#### Scenario: Transient failure logs retrying context
- **WHEN** the handler throws a `TransientPayrollFailureError` on attempt N (where N < max attempts)
- **THEN** the worker SHALL emit a structured log entry at `warn` level tagged `retrying` carrying `eventId`, `employeeId`, `eventType`, `sequence`, current attempt number, and max attempts

### Requirement: Permanent failures are immediately terminal
The system SHALL NOT retry events when the handler throws a `PermanentPayrollFailureError` or any unknown (non-`PayrollProcessingError`) error. On catching such an error, the worker SHALL write the event row to `failed` status and SHALL NOT re-throw.

#### Scenario: Permanent failure marks event failed without retry
- **WHEN** the handler throws a `PermanentPayrollFailureError`
- **THEN** the event row SHALL transition to `failed` status
- **AND** no further BullMQ retry attempt SHALL be scheduled

#### Scenario: Unknown error treated as permanent failure
- **WHEN** the handler throws an error that is not an instance of `PayrollProcessingError`
- **THEN** the event row SHALL transition to `failed` status
- **AND** no further BullMQ retry attempt SHALL be scheduled

#### Scenario: Permanent failure logs permanent-failure context
- **WHEN** the handler throws a `PermanentPayrollFailureError` or unknown error
- **THEN** the worker SHALL emit a structured log entry at `error` level tagged `permanent-failure` carrying `eventId`, `employeeId`, `eventType`, `sequence`, and the failure message

### Requirement: Exhausted retries produce a terminal failed event row
The system SHALL detect when BullMQ has exhausted all retry attempts for a job (i.e., `job.attemptsMade >= job.opts.attempts` in the worker `failed` event) and SHALL write the event row to `failed` status. The worker SHALL take no action when the `failed` worker event fires for a non-exhausted mid-retry failure.

#### Scenario: Exhausted retries write failed row
- **WHEN** the BullMQ `failed` event fires with `job.attemptsMade >= job.opts.attempts`
- **THEN** the event row SHALL be updated to `failed` status

#### Scenario: Mid-retry failed event is a no-op
- **WHEN** the BullMQ `failed` event fires with `job.attemptsMade < job.opts.attempts`
- **THEN** the worker SHALL NOT modify the event row status

### Requirement: Retry policy is configurable via environment variables
The system SHALL read `PAYROLL_MAX_RETRY_ATTEMPTS` and `PAYROLL_RETRY_BASE_DELAY_MS` from the environment (via NestJS `ConfigService`). Both variables SHALL have documented defaults (`5` and `1000` respectively) provided by the Joi validation schema so that existing deployments without these variables continue to operate with safe retry behaviour.

#### Scenario: Default retry configuration applies without env override
- **WHEN** `PAYROLL_MAX_RETRY_ATTEMPTS` and `PAYROLL_RETRY_BASE_DELAY_MS` are not set in the environment
- **THEN** the queue producer SHALL configure jobs with `attempts: 5` and `backoff: { type: "exponential", delay: 1000 }`

#### Scenario: Custom retry configuration overrides defaults
- **WHEN** `PAYROLL_MAX_RETRY_ATTEMPTS=3` and `PAYROLL_RETRY_BASE_DELAY_MS=500` are set
- **THEN** the queue producer SHALL configure jobs with `attempts: 3` and `backoff: { type: "exponential", delay: 500 }`
