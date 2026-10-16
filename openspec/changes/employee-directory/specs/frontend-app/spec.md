# Spec Delta

## Purpose

Wire the UI onto the employee-directory capability: the submit form stops asking for a free-form
`employeeId` and picks from the organization's active directory employees, and a new Employees
view lets the user manage the roster.

## MODIFIED Requirements

### Requirement: The UI can submit each supported event type
The system SHALL provide a submission form that targets `POST /events` with a mandatory `Idempotency-Key` header and an `Authorization: Bearer <accessToken>` header carrying the signed-in user's access token. For each supported event type (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`, `DEPARTMENT_CHANGE`) the form SHALL render exactly the required fields defined for that type by the `event-submission` capability, and SHALL construct the request body as `{ "eventType": <type>, "payload": { <fields> } }`. The form's `employeeId` field SHALL be backed by the `employee-directory`: it SHALL offer the organization's **active** employees (fetched from `GET /employees?active=true`, with the seeded `EMP-DEMO-*` entries included) and SHALL NOT accept an arbitrary unlisted value; selecting a demo scenario SHALL pre-fill that scenario's demo employee. Every submit SHALL generate a fresh UUID as the `Idempotency-Key` header value. On HTTP `201` the UI SHALL display the returned `id` and `status` and add the event to the tracked list. On HTTP `400` or `422` the UI SHALL surface the structured error message without losing the entered values. A submission SHALL only be possible while a session is active; the submission form SHALL NOT be reachable without one.

#### Scenario: Submit BANK_ACCOUNT_CHANGE
- **WHEN** the signed-in user selects `BANK_ACCOUNT_CHANGE`, picks an employee in the directory-backed `employeeId` field, fills `effectiveDate` and `iban`, and submits
- **THEN** the UI SHALL send `POST /events` with body `{ "eventType": "BANK_ACCOUNT_CHANGE", "payload": { "employeeId": …, "effectiveDate": …, "iban": … } }`, an `Idempotency-Key` header, and the access token, display the returned `{ id, status }`, and add the event to the tracked list

#### Scenario: Employee field lists directory employees
- **WHEN** the signed-in user opens the submission form after their organization registered employees
- **THEN** the `employeeId` field SHALL offer exactly the organization's active employees — not a free-text input — including the five `EMP-DEMO-*` entries

#### Scenario: Demo scenario pre-fills its demo employee
- **WHEN** the user picks a demo scenario in the selector
- **THEN** the form SHALL pre-fill the matching `EMP-DEMO-*` employee along with the scenario's sample field values

#### Scenario: Fields are swapped per event type
- **WHEN** the user selects `ADDRESS_CHANGE` and then `SALARY_CHANGE`
- **THEN** the form SHALL render `street`, `city`, `postalCode`, `country` for `ADDRESS_CHANGE` and `newSalary`, `currency` for `SALARY_CHANGE`, with the employee picker and `effectiveDate` present for both, matching the `event-submission` field contract

#### Scenario: Missing required field is blocked before submitting
- **WHEN** the user attempts to submit with a required field of the selected type left empty
- **THEN** the UI SHALL show a field-level validation message and SHALL NOT send a request

#### Scenario: API validation error is surfaced
- **WHEN** the API responds `400` (for example a malformed IBAN or an unknown field)
- **THEN** the UI SHALL display the structured error message and keep the entered values editable

#### Scenario: An employee archived under the user is surfaced
- **WHEN** the API responds `422` because the employee the user picked was archived before the submit
- **THEN** the UI SHALL display the structured error message referencing `employeeId` and keep the entered values editable

#### Scenario: Fresh Idempotency-Key per submission
- **WHEN** the user submits two events in sequence
- **THEN** the two requests SHALL carry different `Idempotency-Key` header values

#### Scenario: Submission form is unavailable without a session
- **WHEN** no session is active
- **THEN** the UI SHALL present the sign-in/registration step instead of the submission form and SHALL NOT allow a submission to be sent

## ADDED Requirements

### Requirement: The UI manages the organization's employee directory
The system SHALL provide an Employees view, reachable from the workspace view switch alongside
the event views, that renders the directory from `GET /employees` alone: on open and after any
change it SHALL fetch the current page (employee number, name, department, active flag, created
time) for the signed-in organization, with an `active` filter and a load-more action following
`nextCursor`. The view SHALL let the user register an employee (`employeeNumber`, `name`,
optional `department`), correct `name` / `department` / `active` on an existing employee, and
archive one with confirmation; surfacing the structured error message on `400`/`409` without
losing entered values. An archived employee SHALL be shown as archived in the list and SHALL no
longer be offered by the submission form's employee field. Directory data SHALL only be fetched
and mutated with the session token; reloads SHALL show the same data the server holds, and a
different organization signing in SHALL see only its own directory.

#### Scenario: Registering an employee appears immediately
- **WHEN** the user submits the create form with valid values
- **THEN** the new employee SHALL appear in the list (and in the submission form's picker) fetched from the server, without a page reload

#### Scenario: A duplicate employee number is surfaced
- **WHEN** the user registers an `employeeNumber` that already exists in the organization
- **THEN** the UI SHALL show the structured `409` error and keep the form values editable

#### Scenario: Editing and archiving update the row in place
- **WHEN** the user corrects an employee's department or archives them (confirming when prompted)
- **THEN** the row SHALL reflect the change fetched from the server, and an archived employee SHALL be marked inactive

#### Scenario: Archiving removes the employee from the submit picker
- **WHEN** an employee the user previously used in the submission form is archived
- **THEN** the submission form SHALL no longer offer that employee for new submissions

#### Scenario: Empty and filtered directory are represented, not improvised
- **WHEN** the organization has no employees matching the current `active` filter
- **THEN** the view SHALL show an empty state rather than stale or locally-invented rows

#### Scenario: A session switch leaves no directory residue
- **WHEN** the user signs out and a different organization signs in
- **THEN** the Employees view SHALL show only the new organization's directory, fetched with the current session's token
