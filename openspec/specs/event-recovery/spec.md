# Event Recovery

## Purpose

Let an operator or integrator correct the pipeline by hand: put terminal failures back to work through a retry action, stop pending events through a cancel action — with tenant-scoped transition guards that never fight the automated exactly-once lifecycle, an append-only audit of every effective manual action, and attempt numbering that stays continuous across retry rounds.

## Requirements

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

### Requirement: A retried event rejoins its employee's chain without breaking the FIFO contract
A retried event SHALL be scheduled through the same per-employee mechanism as a submission: it SHALL wait while an earlier job for the same employee is still in flight and SHALL take its turn in sequence order among that employee's pending events. The worker SHALL claim a retried event only while it is `queued`, so a retried event that has already been claimed, cancelled, or completed SHALL be processed no further; the exactly-once terminal write SHALL be preserved on every retry round.

#### Scenario: Retried event waits behind an in-flight newer event
- **WHEN** a failed event is retried while a later event of the same employee is still being processed
- **THEN** the retry re-queues the failed row, and the event SHALL be scheduled by the employee's relay when the in-flight job finishes, in sequence order among the pending events

#### Scenario: A retried event processes exactly once
- **WHEN** a retried event reaches `success`
- **THEN** exactly one SUCCESS attempt row SHALL be recorded for that attempt number, and no duplicate processing SHALL occur even if a duplicate job for the event exists

#### Scenario: A cancelled retried event is not processed
- **WHEN** a client cancels a retied event between the retry and the worker claiming it
- **THEN** the event SHALL NOT be processed and SHALL remain `cancelled`

### Requirement: Attempt numbering continues across retry rounds
The `event_attempts` trail of an event SHALL be continuous: the first attempt recorded for a retry round SHALL be numbered directly after the last attempt recorded by the previous rounds, and every attempt of every round SHALL be recorded exactly once with its own number. Rows recorded by earlier rounds SHALL never be modified or removed by a later round, preserving the append-only audit trail.

#### Scenario: Numbering continues after a permanent failure round
- **WHEN** an event permanently failed on attempt 1 and is retried, and its second round runs
- **THEN** the attempts recorded for the second round SHALL number from 2, and the attempt-1 row SHALL remain unchanged

#### Scenario: Numbering continues after an exhausted-transient round
- **WHEN** an event exhausted its automatic retries with transient failures (FAILED rows at 1..5) and a client retries it
- **THEN** the attempts recorded for the new round SHALL number from 6, with no collision against, or modification of, the earlier rows

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

### Requirement: Cancelled events are never processed
A cancelled event SHALL never be processed: a queue job that later surfaces for a cancelled event SHALL be a no-op — no claim, no handler dispatch, no attempt row — and the per-employee chain SHALL continue draining the remaining pending events as if that event had completed. This SHALL hold whether the job is still waiting, waiting out a retry backoff, or delivered late.

#### Scenario: A waiting job for a cancelled event does nothing
- **WHEN** a queued event is cancelled and its queue job later runs
- **THEN** the job SHALL apply no side effects — the event stays `cancelled` with no attempt rows — and SHALL complete without error

#### Scenario: Cancellation wins over a retry-backoff job
- **WHEN** an event is cancelled while it sits in `queued` status between automatic BullMQ retry attempts
- **THEN** the pending retry SHALL run to a no-op when its backoff elapses, the event SHALL remain `cancelled`, and no attempt SHALL be recorded after the cancellation

#### Scenario: The employee chain continues after a cancellation
- **WHEN** a pending event is cancelled while other pending events exist for the same employee
- **THEN** the next pending event in sequence order SHALL still be processed by the employee's relay

### Requirement: Cancelled is a terminal state with no further lifecycle
`CANCELLED` SHALL be terminal: no retry, automatic or manual, SHALL schedule a cancelled event again, and a second cancellation SHALL be rejected. The only path out of `cancelled` SHALL be none.

#### Scenario: A cancelled event cannot be retried
- **WHEN** a client calls `POST /events/{id}/retry` for a `cancelled` event
- **THEN** the response SHALL be HTTP `409` and the event SHALL remain `cancelled`

#### Scenario: A second cancellation is rejected
- **WHEN** a client calls `POST /events/{id}/cancel` again on an already cancelled event
- **THEN** the response SHALL be HTTP `409`

### Requirement: Effective manual actions are recorded in an append-only audit trail
The system SHALL record every effective recovery action — which action (`RETRY` or `CANCEL`), which event, which authenticated user performed it, and when — in an append-only audit table scoped to the event. Rejected actions (`409`), unknown or foreign events (`404`), and unauthorized calls (`401`) SHALL record nothing. Audit rows SHALL never be updated or deleted.

#### Scenario: Retry records an audited action
- **WHEN** an authenticated client retries a failed event and the action succeeds
- **THEN** an audit row SHALL exist naming the `RETRY` action, the event, and the acting user

#### Scenario: Cancel records an audited action
- **WHEN** an authenticated client cancels a queued event and the action succeeds
- **THEN** an audit row SHALL exist naming the `CANCEL` action, the event, and the acting user

#### Scenario: Rejected actions record nothing
- **WHEN** a recovery action is rejected with `409`, `404`, or `401`
- **THEN** no audit row SHALL be created for that call
