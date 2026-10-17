# Spec Delta: employee-domain-state

## Purpose

Effective-dated employee state produced by payroll-event processing: each successfully processed event persists exactly one append-only state row (compensation, bank account, address, or department) in the same transaction as the event's terminal transition, so processing has durable, exactly-once, tenant-isolated business effects instead of only acknowledged results.

## ADDED Requirements

### Requirement: Successful processing persists effective-dated employee state

When a payroll event is processed successfully, the system SHALL persist exactly one employee-state row for that event, created in the same database transaction as its terminal `processing → success` transition and attempt record. The row SHALL record the change applied by the event's payload together with the payload's effective date, SHALL belong to the event's organization and employee, and SHALL link uniquely to the source event.

#### Scenario: Salary change persists compensation state
- **WHEN** a `SALARY_CHANGE` event for employee `emp-1` with `newSalary` 75000, currency `EUR`, `effectiveDate` 2026-09-01 reaches `success`
- **THEN** exactly one compensation state row SHALL exist for `emp-1` recording salary 75000, currency `EUR`, and effective date 2026-09-01, linked to that event

#### Scenario: Bank account change persists bank-account state
- **WHEN** a `BANK_ACCOUNT_CHANGE` event for employee `emp-1` with IBAN `DE89370400440532013000` reaches `success`
- **THEN** exactly one bank-account state row SHALL exist for `emp-1` recording that IBAN, linked to that event

#### Scenario: Address change persists address state
- **WHEN** an `ADDRESS_CHANGE` event for employee `emp-2` with street, city, postal code, and country payload reaches `success`
- **THEN** exactly one address state row SHALL exist for `emp-2` recording all supplied address fields, linked to that event

#### Scenario: Department change persists department state
- **WHEN** a `DEPARTMENT_CHANGE` event for employee `emp-3` with `newDepartment` `Engineering` reaches `success`
- **THEN** exactly one department state row SHALL exist for `emp-3` recording `Engineering`, linked to that event

#### Scenario: A success event yields exactly one state row
- **WHEN** an event reaches `success` once
- **THEN** exactly one state row linked to that event SHALL exist, and reprocessing a duplicate or stale job for the same event SHALL NOT create another

### Requirement: State writes commit and roll back atomically with the event

Employee state SHALL never exist for an event that is not `success`. The state row SHALL commit together with the terminal `processing → success` transition and the attempt record, or not at all. A handler that fails transiently or permanently, or a worker crash before the successful transaction commits, SHALL leave zero state rows for that event; a later successful retry of the same event SHALL leave exactly one, representing only the applied change.

#### Scenario: Transient failure writes no state
- **WHEN** a handler throws a transient failure for an event
- **THEN** the transaction SHALL abort, the event SHALL return to `queued`, and zero state rows SHALL exist for that event

#### Scenario: Crash before commit writes no state
- **WHEN** the worker process dies after any state-related write but before the transaction commits
- **THEN** the transaction SHALL roll back, the event SHALL remain claimable in `queued`, and zero state rows SHALL exist for that event

#### Scenario: Permanent failure writes no state
- **WHEN** a handler fails permanently for an event
- **THEN** the event SHALL reach `failed` and zero state rows SHALL exist for that event

#### Scenario: Retried event that eventually succeeds yields one row
- **WHEN** an event fails transiently on attempt 1 and succeeds on attempt 2
- **THEN** exactly one state row SHALL exist for the event after attempt 2, representing only the successfully applied change

### Requirement: State rows are append-only and traceable to their source event

The employee-state store SHALL be append-only: rows SHALL never be updated or deleted as a consequence of processing, retry, or recovery actions. Each row SHALL reference the single event that produced it, and at most one state row per event SHALL be enforceable by the store's unique constraint.

#### Scenario: Reprocessing never mutates existing rows
- **WHEN** additional events for the same employee and domain are processed after an existing state row
- **THEN** existing rows SHALL remain unchanged and new rows SHALL append to the timeline

#### Scenario: Source event uniquely determines a row
- **WHEN** any code path attempts to persist state for an event that already has a state row
- **THEN** the store SHALL reject the second row via its unique constraint on the source event

### Requirement: Employee state is scoped to one organization

Every state row SHALL belong to exactly one organization, inherited from its source event. State for the same employee identifier in two different organizations SHALL be independent. Processing a job that names a valid event of another organization SHALL write no state row for any organization.

#### Scenario: Same employee id in two organizations stays independent
- **WHEN** events for employee `emp-1` are processed successfully in organization A and organization B
- **THEN** each organization SHALL hold only its own state rows for `emp-1` and neither SHALL be readable as the other's state

#### Scenario: A job naming a foreign organization's event writes no state
- **WHEN** a worker processes a job whose event id exists but whose carried organization does not match the event's organization
- **THEN** the claim SHALL match no row and no state row SHALL be written for any organization

### Requirement: Point-in-time employee state is defined by effective date

The state timeline per employee, organization, and domain SHALL be ordered by effective date, with processing commit order breaking ties on the same effective date. The employee's state in a domain as of a given date SHALL be the row with the greatest effective date not after that date; rows with future effective dates SHALL NOT change the state before their date. Later processing SHALL NOT retroactively alter what the state was at an earlier date.

#### Scenario: Later effective date supersedes for current state
- **WHEN** `emp-1` has a compensation row effective 2026-01-01 (salary 60000) and a later-processed one effective 2026-06-01 (salary 75000)
- **THEN** the compensation state as of 2026-06-02 SHALL be salary 75000 and the state as of 2026-05-31 SHALL be salary 60000

#### Scenario: Same effective date resolved by processing order
- **WHEN** two compensation events for `emp-1` share effective date 2026-06-01 and are processed in sequence order
- **THEN** the state as of any date on or after 2026-06-01 SHALL come from the row of the event processed later

#### Scenario: Future-dated row does not alter state before its date
- **WHEN** `emp-1`'s latest committed compensation row is effective 2027-01-01
- **THEN** the compensation state as of 2026-10-16 SHALL still come from the greatest row effective on or before that date, not the future-dated row
