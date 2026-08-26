# Frontend App

## Purpose

Provide a minimal React + Vite demo UI that makes the payroll event processing service explorable: submit typed payroll events with a generated `Idempotency-Key`, watch them progress `received → queued → processing → success | failed` through live polling of `GET /events/{id}`, and inspect the processing result and failure trail for a selected event — so the service's reliability behaviour (idempotency, retries, exactly-once outcome) is visible end-to-end.

## ADDED Requirements

### Requirement: The UI can submit each supported event type
The system SHALL provide a submission form that targets `POST /events` with a mandatory `Idempotency-Key` header. For each supported event type (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`) the form SHALL render exactly the required fields defined for that type by the `event-submission` capability, and SHALL construct the request body as `{ "eventType": <type>, "payload": { <fields> } }`. Every submit SHALL generate a fresh UUID as the `Idempotency-Key` header value. On HTTP `201` the UI SHALL display the returned `id` and `status` and add the event to the tracked list. On HTTP `400` the UI SHALL surface the structured error message without losing the entered values.

#### Scenario: Submit BANK_ACCOUNT_CHANGE
- **WHEN** the user selects `BANK_ACCOUNT_CHANGE`, fills `employeeId`, `effectiveDate`, and `iban`, and submits
- **THEN** the UI SHALL send `POST /events` with body `{ "eventType": "BANK_ACCOUNT_CHANGE", "payload": { "employeeId": …, "effectiveDate": …, "iban": … } }` and an `Idempotency-Key` header, display the returned `{ id, status }`, and add the event to the tracked list

#### Scenario: Fields are swapped per event type
- **WHEN** the user selects `ADDRESS_CHANGE` and then `SALARY_CHANGE`
- **THEN** the form SHALL render `street`, `city`, `postalCode`, `country` for `ADDRESS_CHANGE` and `newSalary`, `currency` for `SALARY_CHANGE`, with `employeeId` and `effectiveDate` present for both, matching the `event-submission` field contract

#### Scenario: Missing required field is blocked before submitting
- **WHEN** the user attempts to submit with a required field of the selected type left empty
- **THEN** the UI SHALL show a field-level validation message and SHALL NOT send a request

#### Scenario: API validation error is surfaced
- **WHEN** the API responds `400` (for example a malformed IBAN or an unknown field)
- **THEN** the UI SHALL display the structured error message and keep the entered values editable

#### Scenario: Fresh Idempotency-Key per submission
- **WHEN** the user submits two events in sequence
- **THEN** the two requests SHALL carry different `Idempotency-Key` header values

### Requirement: The tracked list live-polls event statuses
The system SHALL render a list of the events submitted from this browser. For every tracked event whose status is not terminal, the UI SHALL poll `GET /events/{id}` at a fixed interval (default 3 seconds) and update the row's status badge and attempt count without a manual refresh. Polling SHALL stop for events that reach the terminal states `success` or `failed`. Each row SHALL display the event id, `eventType`, `employeeId`, `sequence`, a lifecycle status badge, and the recorded attempt count.

#### Scenario: Event transitions to success without manual refresh
- **WHEN** a submitted event is later processed by the worker while the list is visible
- **THEN** the row's badge SHALL transition toward `success` through subsequent polls and polling SHALL stop once `success` is observed

#### Scenario: Queued badge reflects retry backoff between attempts
- **WHEN** the worker is between BullMQ retry attempts for an event (the commit rolled back)
- **THEN** the row SHALL show a non-terminal badge representing `queued` with zero recorded attempts, consistent with the `event-status-api` contract

#### Scenario: Polling stops at a terminal state
- **WHEN** a tracked event reaches `failed`
- **THEN** the row SHALL show the `failed` badge and the recorded attempt count, and the UI SHALL issue no further `GET /events/{id}` requests for that event

#### Scenario: A failed poll does not break the list
- **WHEN** a single `GET /events/{id}` poll fails (network error or HTTP `404`)
- **THEN** the UI SHALL mark that row as unavailable/errored and continue rendering and polling the other rows

### Requirement: Event details show the result and failure trail
Selecting an event row SHALL open a detail view populated from `GET /events/{id}` that shows: `id`, `status`, `eventType`, `employeeId`, `sequence`, `payload`, `createdAt`, `updatedAt`, `processedAt` (when set), `result` (when present), and the `attempts` array ordered ascending by `attemptNumber`, each attempt exposing `attemptNumber`, `status`, `errorType`, `failedReason`, `result`, and `createdAt` — making temporary vs permanent failure and the exactly-once outcome of processing visible.

#### Scenario: Successful event shows its result
- **WHEN** a `success` event is selected
- **THEN** the detail view SHALL show `processedAt` and the handler `result` stored on the successful attempt

#### Scenario: Failed event shows reason and error type
- **WHEN** a `failed` event is selected
- **THEN** the detail view SHALL show the `failedReason` and `errorType` (`TEMPORARY` or `PERMANENT`) of the failing attempt

#### Scenario: Attempts render in ascending order
- **WHEN** an event has multiple recorded attempts and is selected
- **THEN** the attempts SHALL render in ascending `attemptNumber` order with per-attempt status, result, and `createdAt`

### Requirement: The tracked list persists across reloads
Because no backend list endpoint exists, the UI SHALL persist its tracked event identifiers and last-known summaries in `localStorage`, restore them on page load, and resume status polling for the restored events. The UI SHALL provide an action to clear the tracked list.

#### Scenario: Reload restores the list and resumes polling
- **WHEN** the user reloads the page after submitting events
- **THEN** the previously tracked events SHALL be restored from `localStorage` and their statuses SHALL be re-polled via `GET /events/{id}`

#### Scenario: Tracked list can be cleared
- **WHEN** the user clears the tracked list
- **THEN** the rows SHALL be removed from the view and from `localStorage`

### Requirement: The API location is configurable and the app is containerized
The UI SHALL read the API base URL from a `VITE_API_URL` build-time environment variable, defaulting to `http://localhost:3000`, and SHALL use it as the base origin for all HTTP requests. The repository SHALL ship a `docker/Dockerfile.frontend` and a `docker-compose.yml` `frontend` service that builds and serves the UI (replacing the static nginx placeholder) such that `docker compose up --build` serves the demo UI at `http://localhost:5173` alongside the API, satisfying the `infrastructure-setup` five-service startup requirement.

#### Scenario: Custom API base URL
- **WHEN** the frontend is built with `VITE_API_URL` set to a non-default origin
- **THEN** all API requests SHALL target that origin

#### Scenario: Docker compose serves the real UI
- **WHEN** a developer runs `docker compose up --build` with the API healthy
- **THEN** `http://localhost:5173` SHALL serve the built demo UI and submissions from it SHALL reach the API