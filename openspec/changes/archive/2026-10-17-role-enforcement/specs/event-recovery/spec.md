# Spec Delta

## Purpose

Gate the manual recovery actions behind an ADMIN-or-higher membership role, so cancelling queued
work and re-driving failed work are operator actions rather than available to every member.

## MODIFIED Requirements

### Requirement: A failed event can be retried
The system SHALL expose `POST /events/{id}/retry` for a terminal `failed` event, requiring a
valid access token and a membership role of ADMIN or higher; a caller below the minimum role
SHALL be rejected with HTTP `403`. The action SHALL transition the event to `queued`, schedule it
for processing again, and return HTTP `200` with the event id and its new `queued` status. An
event in any other state SHALL be rejected with HTTP `409`; an event of another organization
SHALL be reported as `404`. Enqueuing SHALL be best-effort: an unavailable queue SHALL not fail
the action nor change the row.

#### Scenario: Failed event is retried
- **WHEN** an authenticated client with role ADMIN or higher calls `POST /events/{id}/retry` for an event in `failed` status
- **THEN** the response SHALL be HTTP `200` with the event's status `queued`, and the event SHALL be processed again by the worker

#### Scenario: Non-failed events are rejected
- **WHEN** a client calls `POST /events/{id}/retry` for an event in `queued`, `received`, `processing`, `success`, or `cancelled` status
- **THEN** the response SHALL be HTTP `409` with the structured error body, and the event's status SHALL be unchanged

#### Scenario: Another organization's event is not retryable
- **WHEN** an authenticated client calls `POST /events/{id}/retry` for an event that exists in a different organization
- **THEN** the response SHALL be HTTP `404` with the same error shape as an unknown id, and no row SHALL change

#### Scenario: Retry works while the queue is unavailable
- **WHEN** Redis is unreachable at the moment a client retries a failed event
- **THEN** the response SHALL still be HTTP `200` with status `queued`, and the event SHALL be scheduled later without any further client action

#### Scenario: Concurrent retries apply once
- **WHEN** two retry calls for the same `failed` event are processed concurrently
- **THEN** exactly one SHALL return HTTP `200`, the other SHALL return HTTP `409`, and the event SHALL be re-scheduled exactly once

#### Scenario: Member is denied the retry action
- **WHEN** an authenticated client with role MEMBER calls `POST /events/{id}/retry` for an event in `failed` status
- **THEN** the response SHALL be HTTP `403` with the structured error body, and the event SHALL remain in `failed` status

### Requirement: A pending event can be cancelled
The system SHALL expose `POST /events/{id}/cancel` for an event whose status is `queued` or
`received`, requiring a valid access token and a membership role of ADMIN or higher; a caller
below the minimum role SHALL be rejected with HTTP `403`. The action SHALL transition the event
to the terminal `CANCELLED` status, return HTTP `200` with the event id and its new `cancelled`
status, and record no processing attempt for the cancellation. An event in any other state SHALL
be rejected with HTTP `409`; an event of another organization SHALL be reported as `404`.

#### Scenario: Queued event is cancelled
- **WHEN** an authenticated client with role ADMIN or higher calls `POST /events/{id}/cancel` for an event in `queued` status
- **THEN** the response SHALL be HTTP `200` with the event's status `cancelled`, and no attempt SHALL be recorded for it

#### Scenario: Stranded received event is cancellable
- **WHEN** a client with role ADMIN or higher cancels an event whose status is still `received`
- **THEN** the response SHALL be HTTP `200` with status `cancelled`

#### Scenario: Terminal and cancelled events are not cancellable
- **WHEN** a client calls `POST /events/{id}/cancel` for an event in `success`, `failed`, or `cancelled` status
- **THEN** the response SHALL be HTTP `409` with the structured error body, and the event's status SHALL be unchanged

#### Scenario: Another organization's event is not cancellable
- **WHEN** an authenticated client calls `POST /events/{id}/cancel` for an event that exists in a different organization
- **THEN** the response SHALL be HTTP `404` with the same error shape as an unknown id, and no row SHALL change

#### Scenario: Member is denied the cancel action
- **WHEN** an authenticated client with role MEMBER calls `POST /events/{id}/cancel` for an event in `queued` status
- **THEN** the response SHALL be HTTP `403` with the structured error body, and the event SHALL remain in `queued` status

#### Scenario: Actions without a token are rejected
- **WHEN** a client calls either recovery action without an `Authorization` header, or with an invalid or expired token
- **THEN** the response SHALL be HTTP `401` and no row SHALL change
