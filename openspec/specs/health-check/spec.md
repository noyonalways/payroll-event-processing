# Health Check

## Purpose

Expose a `GET /health` endpoint that reports the runtime status of the service and its key dependencies (PostgreSQL and Redis). Consumers such as Docker health checks, orchestration, and operators use it to determine whether the service and its dependencies are operational.

## Requirements

### Requirement: Health endpoint returns service status
The system SHALL expose a `GET /health` endpoint that returns HTTP 200 with a JSON body when the service is operational.

The response body SHALL include:
- `status`: `"ok"` or `"degraded"`
- `db`: `"ok"` | `"error"` (result of `SELECT 1`)
- `redis`: `"ok"` | `"error"` (result of Redis `PING`)
- `uptime`: seconds since process start

#### Scenario: All dependencies healthy
- **WHEN** `GET /health` is called and PostgreSQL and Redis are reachable
- **THEN** the response SHALL be HTTP 200 with `{ "status": "ok", "db": "ok", "redis": "ok", "uptime": <number> }`

#### Scenario: Database unreachable
- **WHEN** `GET /health` is called and PostgreSQL is not reachable
- **THEN** the response SHALL be HTTP 200 with `{ "status": "degraded", "db": "error", "redis": "ok", "uptime": <number> }`

#### Scenario: Redis unreachable
- **WHEN** `GET /health` is called and Redis is not reachable
- **THEN** the response SHALL be HTTP 200 with `{ "status": "degraded", "db": "ok", "redis": "error", "uptime": <number> }`