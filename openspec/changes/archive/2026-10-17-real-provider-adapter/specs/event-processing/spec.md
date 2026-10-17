# Spec Delta

## Purpose

Name the provider seam in the processing contract: handlers dispatch the external operation to
the provider resolved for the event's organization, and the simulated provider is that resolved
provider's default implementation — keeping every existing rate, mode, and scenario behaviour.

## MODIFIED Requirements

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
