# API Documentation

## Purpose

Expose an always-on Swagger/OpenAPI documentation surface for the payroll event processing service — an interactive Swagger UI at `GET /api-docs` and a machine-readable OpenAPI 3.1 JSON document at `GET /api-docs-json` — generated from code annotations with no environment toggle, so consumers and reviewers can explore and exercise `POST /events` and `GET /health` in every runtime environment.

## Requirements

### Requirement: Swagger UI is served at /api-docs in every environment
The system SHALL serve an interactive Swagger UI documenting the API at HTTP `GET /api-docs` in every runtime environment (NODE_ENV `development`, `test`, and `production`). The Swagger UI SHALL be registered during application bootstrap unconditionally — there SHALL be no environment toggle or configuration flag that disables it.

#### Scenario: Swagger UI responds in development
- **WHEN** a client requests `GET /api-docs` with NODE_ENV=development
- **THEN** the response SHALL be HTTP 200 with an HTML document served by Swagger UI

#### Scenario: Swagger UI responds in production
- **WHEN** a client requests `GET /api-docs` with NODE_ENV=production
- **THEN** the response SHALL be HTTP 200 with an HTML document served by Swagger UI

### Requirement: Raw OpenAPI document is served at /api-docs-json
The system SHALL serve the machine-readable OpenAPI document (OpenAPI 3.x, JSON) at HTTP `GET /api-docs-json` in every runtime environment. The document SHALL declare `openapi`, `info.title`, `info.version`, `paths`, and `components`.

#### Scenario: OpenAPI JSON includes all API paths
- **WHEN** a client requests `GET /api-docs-json`
- **THEN** the response SHALL be HTTP 200 with content type `application/json` whose `paths` SHALL contain `/events`, `/events/{id}`, and `/health`

#### Scenario: OpenAPI JSON includes component schemas
- **WHEN** a client requests `GET /api-docs-json`
- **THEN** `components.schemas` SHALL contain `CreateEventDto`, `EventSubmissionResponseDto`, `EventStatusResponseDto`, `EventAttemptDto`, `ErrorResponseDto`, `HealthResponseDto`, `EventType`, `BankAccountChangePayloadDto`, `AddressChangePayloadDto`, and `SalaryChangePayloadDto`

### Requirement: POST /events is fully documented
The system SHALL document the `POST /events` operation with: a request body whose `application/json` schema references `CreateEventDto`; a `required` header parameter named `Idempotency-Key`; an HTTP `201` response typed as `EventSubmissionResponseDto`; an HTTP `400` response typed as `ErrorResponseDto`; and media-type request examples covering the three supported event types so the Swagger UI "Try it out" can be invoked with a valid body in one click.

#### Scenario: Idempotency-Key header documented as required
- **WHEN** a client inspects the OpenAPI document for `POST /events`
- **THEN** the operation SHALL declare a header parameter named `Idempotency-Key` with `required: true`

#### Scenario: Request-body examples cover all three event types
- **WHEN** a client inspects the OpenAPI document for `POST /events`
- **THEN** the `requestBody` SHALL expose named examples whose values are valid bodies for `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, and `SALARY_CHANGE`

#### Scenario: payload field references per-type schemas
- **WHEN** a client inspects `CreateEventDto` in the OpenAPI document
- **THEN** its `payload` property SHALL reference `BankAccountChangePayloadDto`, `AddressChangePayloadDto`, and `SalaryChangePayloadDto` via `oneOf`

### Requirement: GET /events/{id} is documented with a typed response
The system SHALL document the `GET /events/{id}` operation with a path parameter named `id`, an HTTP `200` response typed as `EventStatusResponseDto`, and an HTTP `404` response typed as `ErrorResponseDto`. `EventStatusResponseDto` SHALL declare `id`, `eventType`, `employeeId`, `sequence`, `status`, `payload`, `createdAt`, `updatedAt`, `processedAt`, `result`, and `attempts`, each carrying a description and example where applicable. The `attempts` property SHALL be an array of `EventAttemptDto` objects exposing `attemptNumber`, `status`, `errorType`, `failedReason`, `result`, and `createdAt`.

#### Scenario: Event status schema present in components
- **WHEN** a client inspects the OpenAPI document for `GET /events/{id}`
- **THEN** the 200 response SHALL reference `EventStatusResponseDto` and its `attempts` property SHALL reference `EventAttemptDto`; the 404 response SHALL reference `ErrorResponseDto`

### Requirement: GET /health is documented with a typed response
The system SHALL document the `GET /health` operation with an HTTP `200` response typed as `HealthResponseDto`, whose properties `status`, `db`, `redis`, `uptime`, `timestamp`, `workers`, and `stalled` each carry a description and example. `workers` SHALL be an array of worker-liveness objects exposing `workerId`, `hostname`, `lastSeenAt`, and `stale`; `stalled` SHALL be the count of stalled BullMQ jobs.

#### Scenario: Health schema present in components
- **WHEN** a client inspects the OpenAPI document for `GET /health`
- **THEN** the 200 response SHALL reference `HealthResponseDto` and `HealthResponseDto` SHALL declare `status`, `db`, `redis`, `uptime`, `timestamp`, `workers`, and `stalled`

### Requirement: Error responses are documented
The system SHALL document the structured error shape produced by the global `HttpExceptionFilter` (`statusCode`, `message`, `error`, `timestamp`, `path`) as `ErrorResponseDto`, referenced by the error responses of the documented operations.

#### Scenario: 400 response references ErrorResponseDto
- **WHEN** a client inspects the `POST /events` operation
- **THEN** its HTTP 400 response SHALL reference `ErrorResponseDto`

### Requirement: The OpenAPI document describes the authentication endpoints and their contract
The OpenAPI document SHALL document the authentication operations with their request bodies and response shapes: `POST /auth/register` (request body schema, `201` with a session, `409` for a duplicate email), `POST /auth/login` (request body schema, `200` with a session, `401` for invalid credentials), `POST /auth/refresh` (`200` with a rotated session, `401` when the token is unknown, expired, or already used), `POST /auth/logout` (body schema, `204`), and `GET /auth/me` (`200` with the current identity). The response schema for a session SHALL document the access token, the refresh token, the token type, the access-token lifetime, the refresh expiry, and the actor's user, organization, and role.

#### Scenario: Authentication operations are listed
- **WHEN** a client requests the OpenAPI JSON document
- **THEN** it SHALL contain operations for `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, and `/auth/me`, each with a documented request body or response schema where applicable

#### Scenario: Session schema is documented
- **WHEN** a client inspects the `201` response of `/auth/register` in the OpenAPI document
- **THEN** the schema SHALL include `accessToken`, `refreshToken`, `tokenType`, `expiresIn`, `refreshExpiresAt`, and the nested user, organization, and role fields

### Requirement: Protected operations are documented as requiring a bearer token
The OpenAPI document SHALL declare bearer-token authentication as a security scheme and SHALL mark every operation that requires an access token as secured by it, including `POST /events` and `GET /events/{id}`. Operations that are reachable without a token — `GET /health` and the authentication entry points — SHALL NOT require the scheme. Each protected operation SHALL document an HTTP `401` response.

#### Scenario: Bearer scheme is declared
- **WHEN** a client requests the OpenAPI JSON document
- **THEN** `components.securitySchemes` SHALL contain a bearer authentication scheme

#### Scenario: Protected operations reference the scheme
- **WHEN** a client inspects `POST /events` or `GET /events/{id}`
- **THEN** the operation SHALL declare the bearer security requirement and a documented `401` response

#### Scenario: Public operations remain unauthenticated
- **WHEN** a client inspects `GET /health`, `/auth/register`, or `/auth/login`
- **THEN** the operation SHALL NOT declare a bearer security requirement
