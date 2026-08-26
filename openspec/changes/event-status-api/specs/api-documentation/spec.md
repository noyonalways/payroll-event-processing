## MODIFIED Requirements

### Requirement: Raw OpenAPI document is served at /api-docs-json
The system SHALL serve the machine-readable OpenAPI document (OpenAPI 3.x, JSON) at HTTP `GET /api-docs-json` in every runtime environment. The document SHALL declare `openapi`, `info.title`, `info.version`, `paths`, and `components`.

#### Scenario: OpenAPI JSON includes all API paths
- **WHEN** a client requests `GET /api-docs-json`
- **THEN** the response SHALL be HTTP 200 with content type `application/json` whose `paths` SHALL contain `/events`, `/events/{id}`, and `/health`

#### Scenario: OpenAPI JSON includes component schemas
- **WHEN** a client requests `GET /api-docs-json`
- **THEN** `components.schemas` SHALL contain `CreateEventDto`, `EventSubmissionResponseDto`, `EventStatusResponseDto`, `EventAttemptDto`, `ErrorResponseDto`, `HealthResponseDto`, `EventType`, `BankAccountChangePayloadDto`, `AddressChangePayloadDto`, and `SalaryChangePayloadDto`

## ADDED Requirements

### Requirement: GET /events/{id} is documented with a typed response
The system SHALL document the `GET /events/{id}` operation with a path parameter named `id`, an HTTP `200` response typed as `EventStatusResponseDto`, and an HTTP `404` response typed as `ErrorResponseDto`. `EventStatusResponseDto` SHALL declare `id`, `eventType`, `employeeId`, `sequence`, `status`, `payload`, `createdAt`, `updatedAt`, `processedAt`, `result`, and `attempts`, each carrying a description and example where applicable. The `attempts` property SHALL be an array of `EventAttemptDto` objects exposing `attemptNumber`, `status`, `errorType`, `failedReason`, `result`, and `createdAt`.

#### Scenario: Event status schema present in components
- **WHEN** a client inspects the OpenAPI document for `GET /events/{id}`
- **THEN** the 200 response SHALL reference `EventStatusResponseDto` and its `attempts` property SHALL reference `EventAttemptDto`; the 404 response SHALL reference `ErrorResponseDto`