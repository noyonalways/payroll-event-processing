# Spec Delta

## ADDED Requirements

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
