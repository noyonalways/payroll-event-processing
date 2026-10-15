# Spec Delta

## ADDED Requirements

### Requirement: The health endpoint is reachable without credentials
`GET /health` SHALL be served without requiring an access token, even though authentication is the default for every other route. The endpoint SHALL expose only service, dependency, worker-liveness, and queue-stall status, and SHALL NOT expose any organization-owned data or accept an organization as input. Its response contract SHALL be unchanged by the introduction of authentication.

#### Scenario: Health check without a token
- **WHEN** a client requests `GET /health` with no `Authorization` header
- **THEN** the response SHALL be HTTP `200` with the same body shape as before authentication was introduced, and SHALL NOT be rejected with HTTP `401`

#### Scenario: Health is not organization-scoped
- **WHEN** a client requests `GET /health` with an access token for any organization
- **THEN** the response SHALL report the same service-wide status as a request made without a token
