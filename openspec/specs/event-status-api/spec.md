# Event Status API

## Purpose

Expose a read-only `GET /events/{id}` endpoint that returns the current lifecycle state and full details of a payroll event, including its terminal attempt trail, so clients can track a submitted event from queued through processing to its terminal state without mutating any row.

## Requirements

### Requirement: Event status can be queried by id
The system SHALL expose a read-only `GET /events/{id}` endpoint that returns the current lifecycle state and full details of the payroll event with the given id, provided the event belongs to the organization of the caller's session. The endpoint SHALL require a valid access token and SHALL reject a request without one with HTTP `401`. A request SHALL NOT require an `Idempotency-Key` header and SHALL NOT modify any row in the database. An event that belongs to a different organization SHALL be reported with HTTP `404`, identical to an id that does not exist. On success the system SHALL return HTTP `200` with a body carrying: `id`, `status` (one of `received`, `queued`, `processing`, `success`, `failed`), `eventType`, `employeeId`, `sequence`, `payload`, `createdAt`, `updatedAt`, and, when present, `processedAt` (set on `success`, null otherwise) and `result` (the handler result on `success`, null otherwise). The body SHALL also carry an `attempts` array with one entry per terminal attempt recorded in `event_attempts`, each exposing `attemptNumber`, `status` (`SUCCESS` or `FAILED`), `errorType` (`TEMPORARY`, `PERMANENT`, or null), `failedReason` (or null), `result` (or null), and `createdAt`, ordered ascending by `attemptNumber`.

#### Scenario: Queued event is retrievable
- **WHEN** a client submits an event and then calls `GET /events/{id}` with its id before processing completes
- **THEN** the response SHALL be HTTP `200` with `status` `queued`, `eventType`, `employeeId`, `sequence`, and `payload` matching the submission, and `attempts` SHALL be `[]`

#### Scenario: Successful event returns its result and attempts
- **WHEN** an event has reached `success` and a client calls `GET /events/{id}`
- **THEN** the response SHALL be HTTP `200` with `status` `success`, a non-null `processedAt`, `result` equal to the handler's stored result, and an `attempts` array whose `SUCCESS` entry has the same `result` and `attemptNumber` matching the attempt on which it succeeded

#### Scenario: Failed event returns its failure reason and attempts
- **WHEN** an event has reached `failed` and a client calls `GET /events/{id}`
- **THEN** the response SHALL be HTTP `200` with `status` `failed`, `processedAt` null, `result` null, and an `attempts` array containing a `FAILED` entry with its `errorType` and `failedReason`

#### Scenario: Attempts are ordered by attempt number
- **WHEN** an event has multiple recorded terminal attempts and a client calls `GET /events/{id}`
- **THEN** the `attempts` array SHALL be ordered ascending by `attemptNumber`

#### Scenario: Unknown event id returns 404
- **WHEN** a client calls `GET /events/{id}` with an id for which no event exists
- **THEN** the response SHALL be HTTP `404` with the structured `ErrorResponseDto` body and no database mutation SHALL occur

#### Scenario: Status query without a token is rejected
- **WHEN** a client calls `GET /events/{id}` for an existing event without an `Authorization` header
- **THEN** the response SHALL be HTTP `401` and no event details SHALL be returned

#### Scenario: Another organization's event is not readable
- **WHEN** an authenticated client calls `GET /events/{id}` for an event that exists in a different organization
- **THEN** the response SHALL be HTTP `404` with the same error shape as an unknown id, and SHALL NOT disclose any field of that event

### Requirement: Status responses are consistent with the terminal lifecycle
The reported `status` in `GET /events/{id}` SHALL always reflect the committed row state in `payroll_events`. Because the processing lifecycle commits its claim and terminal write in a single transaction, the response SHALL NOT report a row as `processing` outside an in-flight transaction; a client polling `GET /events/{id}` SHALL observe `queued` (or the terminal state) across attempts, never a stuck `processing`. The response's `attempts` array SHALL be consistent with the reported `status`: `success` implies at least one `SUCCESS` attempt, `failed` implies at least one `FAILED` attempt.

#### Scenario: Polling a transiently failing event returns queued between attempts
- **WHEN** a client polls `GET /events/{id}` while an event is between BullMQ retry attempts
- **THEN** the response SHALL report `status` `queued` with `attempts` `[]`, reflecting the rolled-back claim

#### Scenario: Terminal status matches the attempt trail
- **WHEN** an event has reached a terminal state (`success` or `failed`)
- **THEN** the response's `status` SHALL match the terminal transition and the `attempts` array SHALL contain at least one entry consistent with it (`SUCCESS` for `success`, `FAILED` for `failed`)
