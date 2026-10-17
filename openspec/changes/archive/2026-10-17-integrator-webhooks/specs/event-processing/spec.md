# Spec Delta

## Purpose

Fold the webhook delivery intent into the worker's atomic terminal commit so a terminal
transition can never commit without its notification intent — the same exactly-once discipline
the transaction already applies to the terminal state and its attempt audit row.

## MODIFIED Requirements

### Requirement: Worker processes each event transactionally with a row lock
The worker SHALL process an event inside a single database transaction that SHALL take a row lock
(`SELECT … FOR UPDATE`) on the event row before claiming it, SHALL transition the row `queued →
processing` with a guarded update (only when the row is currently `queued`), SHALL read the event
payload, SHALL dispatch the event to its handler, and SHALL commit the terminal transition
together with the claim. Every statement in that transaction SHALL be scoped by the event's
organization in addition to the event identifier, so a job naming a valid event of another
organization SHALL claim and mutate nothing. The row lock SHALL ensure that even when multiple
worker instances race, only one worker processes a given event at a time; a contender that finds
the row already claimed or terminal SHALL apply no side effects. When the handler throws a
transient failure, the transaction SHALL abort and the claim SHALL roll back to `queued`. When
the handler fails permanently, the terminal `processing → failed` transition SHALL commit. A
crash or connection loss before commit SHALL leave the row claimable in `queued`, never stuck in
`processing`. When the organization has at least one active webhook endpoint, the transaction
SHALL additionally create a pending webhook delivery intent for the committed terminal state;
the intent SHALL commit atomically with the terminal transition, and webhook delivery shall never
delay, fail, or roll back the event's own commit.

#### Scenario: Success commits the claim and terminal write atomically
- **WHEN** the worker processes a job whose handler succeeds
- **THEN** the row SHALL reach `success` with `result` and `processed_at` set, and the `processing` claim SHALL have been committed in the same transaction as the terminal transition

#### Scenario: Transient failure aborts and returns the row to queued
- **WHEN** the worker processes a job whose handler throws a transient failure
- **THEN** the transaction SHALL abort, the row SHALL be `queued` again (no `processing` residue), and the job SHALL be retried by the queue

#### Scenario: Crash before commit leaves the row claimable
- **WHEN** the worker process is killed after the claim but before the terminal transition commits
- **THEN** the claim SHALL be rolled back and the row SHALL remain `queued`, claimable by a later attempt

#### Scenario: Concurrent worker on the same event is a no-op
- **WHEN** two workers attempt to claim the same event row
- **THEN** exactly one SHALL commit a `queued → processing` transition and the other SHALL observe the row as no longer `queued` and SHALL apply no side effects

#### Scenario: A job naming a foreign organization's event changes nothing
- **WHEN** the worker processes a job whose event id exists but belongs to a different organization than the job carries
- **THEN** the claim SHALL match no row, the event SHALL be left untouched, and no attempt SHALL be recorded against it

#### Scenario: Terminal commit writes its delivery intent atomically
- **WHEN** the worker commits a terminal transition for an event in an organization with at least one active webhook endpoint
- **THEN** the same transaction SHALL persist a pending delivery intent per active endpoint, and no intent SHALL exist when the transaction aborts
