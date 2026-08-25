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
Each handler SHALL run the simulated external payroll operation for its event type and, on success, SHALL return a result object that describes the applied change. The result SHALL identify the simulated external operation (a reference string), the employee, the effective date, and the affected fields with their new values. The result shape SHALL be permitted to differ per event type.

#### Scenario: Bank account change produces a result
- **WHEN** the `BANK_ACCOUNT_CHANGE` handler processes an event for employee `emp-1` with `iban` `DE89370400440532013000`
- **THEN** it SHALL return a success result whose reference is non-empty and whose affected-field payload acknowledges the `iban` value `DE89370400440532013000`

#### Scenario: Salary change produces a result
- **WHEN** the `SALARY_CHANGE` handler processes an event for employee `emp-3` with `newSalary` `75000`
- **THEN** it SHALL return a success result whose reference is non-empty and whose affected-field payload acknowledges `newSalary` `75000`

#### Scenario: Address change produces a result
- **WHEN** the `ADDRESS_CHANGE` handler processes an event for employee `emp-2`
- **THEN** it SHALL return a success result whose reference is non-empty and whose affected-field payload acknowledges the supplied address fields

### Requirement: Simulated provider fails transiently or permanently at configurable rates
The system SHALL provide a simulated external payroll provider that succeeds or fails according to configurable rates: `PAYROLL_TEMPORARY_FAILURE_RATE` (probability of a transient failure, default 0.25) and `PAYROLL_PERMANENT_FAILURE_RATE` (probability of a permanent failure, default 0.05). Transient failures SHALL be distinguishable from permanent failures (distinct error classes). A transient failure SHALL be a failure that could succeed on retry; a permanent failure SHALL be a business-level failure that retrying would not fix.

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