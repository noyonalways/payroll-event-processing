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

### Requirement: /health reports worker liveness
The system SHALL report worker liveness from the `worker_heartbeats` table and the BullMQ queue in `GET /health`. The response SHALL include a `workers` array with one entry per registered worker carrying `workerId`, `hostname`, `lastSeenAt`, and a boolean `stale` computed against `HEALTH_WORKER_STALE_MS` (default 15000): a worker whose `lastSeenAt` is older than the threshold SHALL be `stale: true`. The response SHALL include a `stalled` field carrying the BullMQ `stalled` job count for the `payroll-events` queue. The overall `status` SHALL be `"degraded"` when any registered worker is stale or the `stalled` count is greater than zero, and `"ok"` otherwise, while the endpoint SHALL still return HTTP 200 so orchestration can observe the degraded state.

#### Scenario: Live worker reports ok
- **WHEN** `GET /health` is called and every `worker_heartbeats` row has `lastSeenAt` within `HEALTH_WORKER_STALE_MS` and no jobs are stalled
- **THEN** the response SHALL be HTTP 200 with `{ "status": "ok", "workers": [ { "workerId": <string>, "stale": false, ... } ], "stalled": 0 }`

#### Scenario: Stale worker reports degraded
- **WHEN** `GET /health` is called and a `worker_heartbeats` row has `lastSeenAt` older than `HEALTH_WORKER_STALE_MS`
- **THEN** the response SHALL be HTTP 200 with `{ "status": "degraded" }` and that worker's entry SHALL have `"stale": true`

#### Scenario: Stalled jobs report degraded
- **WHEN** `GET /health` is called and the `payroll-events` queue has a stalled job count greater than zero
- **THEN** the response SHALL be HTTP 200 with `{ "status": "degraded", "stalled": <positive number> }`