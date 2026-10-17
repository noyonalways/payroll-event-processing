# event-status-stream Specification

## Purpose

Push committed payroll-event lifecycle transitions to connected clients in real time over an authenticated server-sent-events stream, so status tracking no longer depends on client polling. The stream is a best-effort notification surface: the database row remains the only source of truth, and no lifecycle transition ever waits on or fails because of it.

## Requirements

### Requirement: The lifecycle stream is an authenticated read-only endpoint

The system SHALL expose `GET /events/stream` that responds `text/event-stream` and stays open, pushing notifications as server-sent events whose `data` is a JSON object per notification. The endpoint SHALL require a valid access token (the same header authentication as every other event endpoint) and SHALL reject a request without one with HTTP `401`. The endpoint SHALL NOT require an `Idempotency-Key` header and SHALL NOT modify any database row: an open stream is a pure observer.

#### Scenario: Stream request without a token is rejected
- **WHEN** a client requests `GET /events/stream` without an `Authorization` header
- **THEN** the response SHALL be HTTP `401` and no stream SHALL be opened

#### Scenario: Authenticated client receives a stream
- **WHEN** a client with a valid access token requests `GET /events/stream`
- **THEN** the response SHALL establish a `text/event-stream` connection that stays open and carries server-sent events
### Requirement: Stream deliveries are scoped to the caller's organization

Every notification delivered on a stream SHALL describe an event that belongs to the subscriber's organization, resolved from the access token exactly as the read endpoints do. Transitions of any other organization SHALL never be delivered on it, and a notification SHALL not disclose that another organization's events exist.

#### Scenario: Another organization's transitions are not delivered
- **WHEN** organization B's event transitions while a subscriber authenticated for organization A holds an open stream
- **THEN** no notification for organization B's event SHALL be delivered on A's stream

#### Scenario: Concurrent organizations observe disjoint streams
- **WHEN** subscribers of two organizations hold open streams and events transition in both
- **THEN** each stream SHALL deliver only its own organization's transitions
### Requirement: Every committed lifecycle transition is announced

The system SHALL publish a notification onto the owning organization's stream for each committed lifecycle status change of a payroll event: submission becoming tracked, the committed terminal outcomes `success` and `failed` (including retry exhaustion), a manual retry (`failed → queued`), and a cancellation. An attempt whose claim was rolled back (retry backoff) SHALL NOT be announced as `processing`.

#### Scenario: A submitted event streams its terminal outcome
- **WHEN** a client submits an event and the worker processes it to `success` while the client's stream is open
- **THEN** the stream SHALL deliver notifications whose statuses carry the event from its queued state through the committed `success` outcome, each naming the event

#### Scenario: A cancelled event is announced
- **WHEN** a pending event is cancelled through `POST /events/{id}/cancel`
- **THEN** the stream SHALL deliver a notification with `status` `cancelled` for that event

#### Scenario: Retry exhaustion is announced
- **WHEN** an event's attempts are exhausted and its row commits to `failed`
- **THEN** the stream SHALL deliver a notification with `status` `failed` for that event

#### Scenario: A rolled-back claim is not announced as processing
- **WHEN** a processing attempt fails transiently (the claim transaction aborts and the row stays `queued`)
- **THEN** the stream SHALL NOT deliver a notification reporting `processing`, and the last announced committed state for the event SHALL remain `queued`
### Requirement: Stream notifications identify the transitioned event

Each stream notification's JSON payload SHALL carry at least `eventId`, `eventType`, `employeeId`, `sequence`, `status` (the newly committed status), and `occurredAt`, and SHALL be published strictly after the announcing transition's database transaction has committed.

#### Scenario: Notification payload parses as JSON with the documented fields
- **WHEN** a stream notification is delivered
- **THEN** its `data` SHALL parse as JSON carrying at least `eventId`, `eventType`, `employeeId`, `sequence`, `status`, and `occurredAt`

#### Scenario: The announced status names the newly committed state
- **WHEN** a notification for an event's latest transition is delivered
- **THEN** its `status` SHALL name the transition's newly committed state, and its `eventId` and `sequence` SHALL match the identity the read endpoints return for that event
### Requirement: Notifications are best-effort

The stream is an accelerator, not a delivery guarantee: the system MAY drop notifications that cannot be published (for example while the stream transport is unavailable), and clients SHALL NOT rely on receiving every notification; the read endpoints (`GET /events`, `GET /events/{id}`) remain the resynchronization path.

#### Scenario: A missed notification is recoverable through the read endpoints
- **WHEN** a client misses a notification (publish dropped or subscriber briefly offline)
- **THEN** a subsequent `GET /events/{id}` SHALL report the event's committed status as if no stream had existed
### Requirement: Publishing never blocks a lifecycle transition

A publish failure SHALL be logged and SHALL NOT fail, delay, or roll back the lifecycle transition or its HTTP response.

#### Scenario: Publishing failure does not fail the operation
- **WHEN** a lifecycle transition commits while the stream transport is unavailable
- **THEN** the transition SHALL still be committed and its HTTP response SHALL be unchanged, the publish failure SHALL be logged, and no notification SHALL be delivered
### Requirement: The stream stays observable and terminates cleanly

While a stream connection is idle the system SHALL deliver a periodic heartbeat so a client can distinguish a live connection from a dead one. The system SHALL close a stream cleanly, without error, when the client disconnects or when the server shuts down.

#### Scenario: An idle stream keeps showing liveness
- **WHEN** no transitions occur for longer than one heartbeat interval while a stream is open
- **THEN** the stream SHALL nonetheless deliver heartbeat activity at the fixed interval

#### Scenario: Client disconnect ends the stream silently
- **WHEN** a client closes or aborts its stream connection
- **THEN** the server SHALL release the connection without logging an error and without delivering further notifications
### Requirement: A fresh subscription carries no replay

A newly opened (or re-opened) stream SHALL deliver only transitions that commit after the subscription is created; the system SHALL NOT replay historical notifications or honour a resume cursor. Continuity across reconnections is the client's responsibility (the `frontend-app` capability re-synchronizes from the read endpoints).

#### Scenario: Reconnecting does not replay history
- **WHEN** a client reopens its stream after a period of disconnection during which transitions occurred
- **THEN** the new stream SHALL NOT deliver notifications for the transitions that happened before it opened
