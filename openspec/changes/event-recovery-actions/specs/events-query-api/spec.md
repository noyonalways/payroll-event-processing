# Spec Delta

## MODIFIED Requirements

### Requirement: Results can be filtered by combinable criteria
`GET /events` SHALL accept combinable filters: `status` (a single lifecycle state: `received`, `queued`, `processing`, `success`, `failed`, or `cancelled`), `eventType` (a supported event type), `employeeId` (matched within the caller's organization), and `createdAfter` / `createdBefore` (ISO-8601 bounds on `created_at`). Filters SHALL combine with AND semantics and SHALL compose with pagination. A filter value that is not valid — an unknown status or event type, a negative or over-sized `limit`, or an unparsable date — SHALL be rejected with HTTP `400` listing the failing parameter.

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

#### Scenario: Cancelled events match the cancelled filter
- **WHEN** a client calls `GET /events?status=cancelled`
- **THEN** `data` SHALL contain that organization's cancelled events, and no other status SHALL appear
