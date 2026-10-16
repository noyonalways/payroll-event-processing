# Spec Delta

## Purpose

Make the event-submission payload contract reference the caller's organization's employee
directory instead of accepting any free-form string, so `employeeId` typos and unknown employees
become a structured rejection at submission time rather than an unprocessable orphan sequence.

## MODIFIED Requirements

### Requirement: Payloads are validated per event type
The system SHALL validate the `payload` against the field contract of its `eventType`:

- `BANK_ACCOUNT_CHANGE`: MUST include `employeeId` (string), `effectiveDate` (ISO date), and `iban` (IBAN format).
- `ADDRESS_CHANGE`: MUST include `employeeId`, `effectiveDate`, `street`, `city`, `postalCode`, and `country`.
- `SALARY_CHANGE`: MUST include `employeeId`, `effectiveDate`, `newSalary` (positive number), and `currency`.

Unknown fields in the payload SHALL be rejected, and any missing or malformed field SHALL result in HTTP `400` with a structured error body listing the failing fields.

In addition, the `employeeId` supplied in any supported payload SHALL reference an **active**
employee of the caller's organization's `employee-directory`: the check SHALL be made within the
submitting organization, so two organizations that use the same employee number remain
independent. A payload whose `employeeId` matches no directory employee in the caller's
organization — or whose matching employee is archived (`active = false`) — SHALL be rejected with
HTTP `422` and the structured error body, and no event SHALL be persisted. This is a business
validation (permanent) rejection: it SHALL be reported before the idempotency layer is consulted,
so a rejected attempt SHALL NOT consume, store, or replay against the request's `Idempotency-Key`
— after the organization registers (or reactivates) the employee, resubmitting with the same key
SHALL create a fresh event.

#### Scenario: Missing required field
- **WHEN** a client POSTs a `BANK_ACCOUNT_CHANGE` event whose `payload` omits `iban`
- **THEN** the response SHALL be HTTP `400` whose error body references `iban`, and no event SHALL be persisted

#### Scenario: Unknown field rejected
- **WHEN** a client POSTs a `SALARY_CHANGE` event whose `payload` contains an unrecognized field such as `"bonus": 1000`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

#### Scenario: Malformed field value
- **WHEN** a client POSTs a `SALARY_CHANGE` event whose `payload` has `"newSalary": "not-a-number"`
- **THEN** the response SHALL be HTTP `400` and no event SHALL be persisted

#### Scenario: Event for an unknown employee is rejected
- **WHEN** an authenticated client POSTs a well-formed `SALARY_CHANGE` event whose `payload.employeeId` does not exist in their organization's directory
- **THEN** the response SHALL be HTTP `422` with a structured error body referencing `employeeId`, and no event SHALL be persisted

#### Scenario: Event for an archived employee is rejected
- **WHEN** a client submits an event for an `employeeId` whose directory employee has been archived
- **THEN** the response SHALL be HTTP `422` and no event SHALL be persisted

#### Scenario: Same employee number stays independent per organization
- **WHEN** organizations A and B both have an employee numbered `emp-001` in their directories
- **THEN** an event for `employeeId` `emp-001` submitted by organization A SHALL be accepted and ordered by A's sequence, and B's events for `emp-001` SHALL be unaffected

#### Scenario: A rejected submission does not consume the Idempotency-Key
- **WHEN** a client submits an event for an unknown `employeeId` with `Idempotency-Key` `k-1` (HTTP `422`), then registers that employee and resubmits the same event with `k-1`
- **THEN** the resubmission SHALL create a new event with HTTP `201` — it SHALL NOT replay the stored `422`

#### Scenario: Demo employee submissions remain accepted
- **WHEN** a client submits an event for a seeded `EMP-DEMO-*` employee of their organization
- **THEN** the submission SHALL pass the directory check and be persisted with HTTP `201`
