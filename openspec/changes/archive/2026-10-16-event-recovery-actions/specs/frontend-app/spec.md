# Spec Delta

## MODIFIED Requirements

### Requirement: The tracked list live-polls event statuses
The system SHALL render the event history list provided by the `events-query-api` capability. For every event shown in that list whose status is not terminal, the UI SHALL poll `GET /events/{id}` at a fixed interval (default 3 seconds) and update the row's status badge and attempt count without a manual refresh. Polling SHALL stop for events that reach the terminal states `success`, `failed`, or `cancelled`. A `failed` row whose recovery action the user invokes SHALL rejoin polling when the action succeeds (its status returns to `queued`). Each row SHALL display the event id, `eventType`, `employeeId`, `sequence`, a lifecycle status badge, and the recorded attempt count.

#### Scenario: Event transitions to success without manual refresh
- **WHEN** an event shown in the list is later processed by the worker while the list is visible
- **THEN** the row's badge SHALL transition toward `success` through subsequent polls and polling SHALL stop once `success` is observed

#### Scenario: Queued badge reflects retry backoff between attempts
- **WHEN** the worker is between BullMQ retry attempts for an event (the commit rolled back)
- **THEN** the row SHALL show a non-terminal badge representing `queued` with zero recorded attempts, consistent with the `event-status-api` contract

#### Scenario: Polling stops at a terminal state
- **WHEN** an event shown in the list reaches `failed`
- **THEN** the row SHALL show the `failed` badge and the recorded attempt count, and the UI SHALL issue no further `GET /events/{id}` requests for that event

#### Scenario: A failed poll does not break the list
- **WHEN** a single `GET /events/{id}` poll fails (network error or HTTP `404`)
- **THEN** the UI SHALL mark that row as unavailable/errored and continue rendering and polling the other rows

#### Scenario: Polling resumes when a failed event is retried
- **WHEN** the user retries a `failed` row and the action succeeds
- **THEN** the row's badge SHALL show `queued` again and the UI SHALL resume polling that event's status until it reaches a terminal state

## ADDED Requirements

### Requirement: Users can trigger recovery actions from the event list
The UI SHALL offer a retry action on `failed` rows and a cancel action on `queued` or `received` rows, calling the corresponding `event-recovery` endpoints with the session token and no `Idempotency-Key` header.

#### Scenario: Failed row offers retry
- **WHEN** the user is shown a row whose status is `failed`
- **THEN** the UI SHALL offer a retry action that, when confirmed, calls `POST /events/{id}/retry` and on success re-activates polling for that row

#### Scenario: Pending row offers cancel
- **WHEN** the user is shown a row whose status is `queued` or `received`
- **THEN** the UI SHALL offer a cancel action that, when confirmed, calls `POST /events/{id}/cancel` and on success shows the row as `cancelled` with no further polling

#### Scenario: Terminal rows offer no actions
- **WHEN** a row's status is `success` or `cancelled`
- **THEN** the UI SHALL NOT offer a retry or cancel action on that row

### Requirement: Recovery actions confirm, then update the row in place
The UI SHALL ask for confirmation before sending a recovery action. On success the UI SHALL update the row from the response without a manual refresh: a retried row re-enters polling; a cancelled row shows `cancelled` with polling stopped. A `409` or `401` response SHALL surface the structured error message without changing the row's status.

#### Scenario: Confirmed action updates the row
- **WHEN** the user confirms a cancel on a `queued` row and the API responds `200` with status `cancelled`
- **THEN** the row SHALL show `cancelled` without the user refetching the page

#### Scenario: Conflicting action is surfaced
- **WHEN** the API responds `409` to a recovery action (for example the row left its eligible state before the call landed)
- **THEN** the UI SHALL display the structured error message and refresh that row's status from `GET /events/{id}`

### Requirement: A dead-letter view surfaces terminal failures for recovery
The UI SHALL provide a dedicated dead-letter view listing the organization's terminal `failed` events, fetched from `GET /events` with the `status=failed` filter of the `events-query-api` capability and paginated the same way. Each entry SHALL expose the event identity, attempt count, and lifecycle badge, and SHALL open the event detail (with its failure trail) and invoke the retry action. An empty view SHALL be represented as an explicit nothing-to-recover state.

#### Scenario: Dead-letter view lists failed events with reasons
- **WHEN** the organization has failed events and the user opens the dead-letter view
- **THEN** each failed event SHALL be listed with its identity, attempt count, and a way to inspect its failure trail from `GET /events/{id}`

#### Scenario: Retrying from the dead-letter view removes the entry
- **WHEN** the user retries an event from the dead-letter view and the action succeeds
- **THEN** the event's status becomes `queued`, and the event SHALL no longer appear as terminal-failed the next time the view's failed-only selection is fetched

#### Scenario: Empty dead-letter view is explicit
- **WHEN** the organization has no failed events
- **THEN** the dead-letter view SHALL show an explicit empty state rather than an empty list skeleton or historical rows

#### Scenario: Dead-letter view only shows the caller's organization
- **WHEN** a signed-in organization's user opens the dead-letter view
- **THEN** the listed events SHALL be only that organization's failed events, scoped by the session token
