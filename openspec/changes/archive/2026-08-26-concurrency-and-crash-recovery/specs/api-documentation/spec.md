## MODIFIED Requirements

### Requirement: GET /health is documented with a typed response
The system SHALL document the `GET /health` operation with an HTTP `200` response typed as `HealthResponseDto`, whose properties `status`, `db`, `redis`, `uptime`, `timestamp`, `workers`, and `stalled` each carry a description and example. `workers` SHALL be an array of worker-liveness objects exposing `workerId`, `hostname`, `lastSeenAt`, and `stale`; `stalled` SHALL be the count of stalled BullMQ jobs.

#### Scenario: Health schema present in components
- **WHEN** a client inspects the OpenAPI document for `GET /health`
- **THEN** the 200 response SHALL reference `HealthResponseDto` and `HealthResponseDto` SHALL declare `status`, `db`, `redis`, `uptime`, `timestamp`, `workers`, and `stalled`