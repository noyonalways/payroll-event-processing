# Spec Delta

## MODIFIED Requirements

### Requirement: The tracked list live-polls event statuses
The system SHALL render the event history list provided by the `events-query-api` capability. For every event shown in that list whose status is not terminal, the UI SHALL poll `GET /events/{id}` at a fixed interval (default 3 seconds) and update the row's status badge and attempt count without a manual refresh. Polling SHALL stop for events that reach the terminal states `success` or `failed`. Each row SHALL display the event id, `eventType`, `employeeId`, `sequence`, a lifecycle status badge, and the recorded attempt count.

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

## REMOVED Requirements

### Requirement: The tracked list persists across reloads
**Reason**: Superseded by server-side history. The list was persisted in `localStorage` only because no list endpoint existed; with `GET /events` providing the organization's history, server data is the source of truth and a browser copy is both useless and a liability (stale rows, cross-session residue).
**Migration**: Use the new server-driven history requirement below; reloads simply re-fetch the first page.

## ADDED Requirements

### Requirement: The UI shows the organization's event history with filters
The system SHALL render the event history from `GET /events` alone: on page load and whenever the active filters change, the UI SHALL fetch the current page for the signed-in organization. The UI SHALL provide filters for `status`, `eventType`, and `employeeId`, and SHALL offer a load-more action following `nextCursor`. Submitting an event SHALL make it appear in the history without any client-side persistence. Reloads SHALL show the same data the server holds. Because the list is server-scoped, ending a session SHALL inherently reveal no other organization's events.

#### Scenario: History loads from the server
- **WHEN** a signed-in user opens the events view
- **THEN** the list SHALL be populated by `GET /events` and SHALL contain events the user submitted in previous sessions, without a form submission in this one

#### Scenario: Filters narrow the visible list
- **WHEN** the user applies a status, event-type, or employee filter
- **THEN** the list SHALL re-fetch from `GET /events` with those filters and show only the matching events

#### Scenario: Submitting an event appears in history
- **WHEN** the user submits an event through the form
- **THEN** the event SHALL appear in the history list without a page reload

#### Scenario: Load more appends the next page
- **WHEN** the user activates the load-more action while a `nextCursor` exists
- **THEN** the next page's events SHALL be appended below the current ones

#### Scenario: An empty history is represented, not improvised
- **WHEN** the organization has no events matching the current filters
- **THEN** the UI SHALL show an empty state rather than stale or locally-invented rows

#### Scenario: Session switch leaves no residue
- **WHEN** the user signs out and a different organization signs in
- **THEN** the events view SHALL show only the new organization's history, fetched with the current session's token
