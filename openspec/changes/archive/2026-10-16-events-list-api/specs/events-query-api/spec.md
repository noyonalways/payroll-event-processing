# Spec Delta

## Purpose

Lets clients page through and filter their organization's event history through one authenticated operation — `GET /events` — returning a stable, explicitly-shaped page of events so a UI or integrator can browse what happened (and what failed) without knowing database internals or keeping its own record.

## ADDED Requirements

### Requirement: Events can be listed for the caller's organization
The system SHALL expose `GET /events`, requiring an access token like every payroll operation. A successful call SHALL return HTTP `200` with a body carrying `data` (the events matching the request), `limit` (the requested page size), and `nextCursor` (an opaque token for the next page, or `null` when no further page exists). Each entry SHALL carry `id`, `eventType`, `employeeId`, `sequence`, `status`, `createdAt`, and `updatedAt`, and SHALL NOT include payload contents, the attempt trail, or processing results — those are the single-event endpoint's contract. The endpoint SHALL NEVER return events belonging to an organization other than the caller's.

#### Scenario: First page of events
- **WHEN** an authenticated client calls `GET /events` with no parameters
- **THEN** the response SHALL be HTTP `200` with `data` containing that organization's newest events first, a `limit` value, and a `nextCursor` that is `null` only when the organization has no further events

#### Scenario: Listing without a token is rejected
- **WHEN** a client calls `GET /events` without an `Authorization` header, or with an invalid or expired token
- **THEN** the response SHALL be HTTP `401` and no events SHALL be returned

#### Scenario: Another organization's events are never returned
- **WHEN** two organizations have events and a client of organization A calls `GET /events`
- **THEN** `data` SHALL contain only organization A's events, regardless of what organization B has stored, and no filter or page parameter SHALL change that

### Requirement: Pagination walks a stable, opaque cursor
The system SHALL support forward pagination: passing `limit` (a positive integer up to a documented maximum) and `cursor` (an opaque token returned by a previous call) SHALL return the events immediately following the cursor in the established order. The ordering SHALL be deterministic — newest first by creation time, with a tiebreaker on the event id — and SHALL NOT depend on how many other events have been written between page requests: an event created after earlier pages were fetched SHALL NOT shift rows between pages. An unparsable cursor SHALL be rejected with HTTP `400`, not treated as absent.

#### Scenario: Walking all pages yields every event exactly once
- **WHEN** a client repeatedly requests pages passing the `nextCursor` until it is `null`
- **THEN** the concatenation of `data` SHALL contain each of the organization's events exactly once

#### Scenario: Pages stay stable while new events are written
- **WHEN** a client fetches page 1, a new event is submitted, and the client then fetches page 2
- **THEN** page 2 SHALL continue from the same position as before, unshifted by the event created in between

#### Scenario: Malformed cursor rejected
- **WHEN** a client passes a `cursor` value that was not issued by the endpoint and cannot be decoded
- **THEN** the response SHALL be HTTP `400` with the structured error body

### Requirement: Results can be filtered by combinable criteria
`GET /events` SHALL accept combinable filters: `status` (a single lifecycle state), `eventType` (a supported event type), `employeeId` (matched within the caller's organization), and `createdAfter` / `createdBefore` (ISO-8601 bounds on `created_at`). Filters SHALL combine with AND semantics and SHALL compose with pagination. A filter value that is not valid — an unknown status or event type, a negative or over-sized `limit`, or an unparsable date — SHALL be rejected with HTTP `400` listing the failing parameter.

#### Scenario: Filters narrow the result set
- **WHEN** a client calls `GET /events?status=failed&eventType=SALARY_CHANGE`
- **THEN** `data` SHALL contain only that organization's failed `SALARY_CHANGE` events

#### Scenario: Filters combine with pagination
- **WHEN** a filtered result set spans a full page and the client follows `nextCursor`
- **THEN** the next page SHALL continue that same filtered selection

#### Scenario: Invalid filter values rejected
- **WHEN** a client calls `GET /events` with an unknown `status`, an unknown `eventType`, or a malformed date
- **THEN** the response SHALL be HTTP `400` with the structured error body identifying the failing parameter

#### Scenario: Employees with the same id in different organizations are independent
- **WHEN** two organizations both have events for `employeeId` `emp-1` and one of them filters its list by that id
- **THEN** only that organization's matching events SHALL be returned

### Requirement: The listing endpoint documents itself and adds no writes
`GET /events` SHALL be documented in the OpenAPI document with its bearer requirement, its typed `200` page response, its query parameters, and its `400`/`401` responses. The endpoint SHALL be strictly read-only: it SHALL NOT enqueue work, mutate rows, or record anything, so listing history never affects lifecycle state.

#### Scenario: Operation is documented as secured and typed
- **WHEN** a client inspects `GET /events`
- **THEN** the operation SHALL declare the bearer security requirement, a documented `200` page schema, its listed query parameters, and `400`/`401` responses

#### Scenario: Listing history performs no writes
- **WHEN** `GET /events` is called repeatedly across filters and pages
- **THEN** no `payroll_events` row SHALL change lifecycle state and no queue work SHALL be created
