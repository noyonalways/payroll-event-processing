## Why

The repository currently contains only a folder skeleton and a README stub. Before any feature work can begin, we need a fully runnable NestJS 11 application with all infrastructure wired up — so that every subsequent change has a working baseline to build on and the project can be started locally with a single command.

## What Changes

- Bootstrap a NestJS 11 (latest stable) + TypeScript (strict) application in `src/`
- Configure Prisma ORM with a PostgreSQL connection; add an initial empty migration
- Set up a Docker Compose file that starts PostgreSQL 16, Redis 7, the NestJS API, a BullMQ worker process, and a placeholder frontend container
- Provide environment variable configuration (`.env.example`) covering database URL, Redis URL, ports, and log level
- Add a `GET /health` endpoint that reports application readiness and optionally checks DB/Redis connectivity
- Set up ESLint + Prettier with project-standard config
- Add a minimal `package.json` / npm workspace setup for `src` (API) and `apps/worker` (standalone worker entry)
- Provide `Dockerfile`s for the API and worker targeting production and development modes
- Add a base `AppModule` wiring together `PrismaModule`, `ConfigModule`, and a stub `EventsModule`

## Capabilities

### New Capabilities

- `app-bootstrap`: NestJS application entry point, `AppModule`, global config, global validation pipe, global exception filter, structured JSON logger
- `health-check`: `GET /health` endpoint returning service status and optional DB/Redis liveness check
- `infrastructure-setup`: Docker Compose, Dockerfiles (API + worker), `.env.example`, Prisma datasource config, initial empty migration, ESLint + Prettier config

### Modified Capabilities

_(none — this is the initial scaffold)_

## Impact

- **New files across the entire repo** — this is the foundational change; all subsequent changes depend on it
- **Docker Compose** introduces service dependencies (Postgres, Redis) that CI and local dev require
- **Prisma schema** starts empty (no models yet) — the next change (`event-submission-api`) will add the `PayrollEvent` model
- No public API surface changes (health check is the only endpoint added)
