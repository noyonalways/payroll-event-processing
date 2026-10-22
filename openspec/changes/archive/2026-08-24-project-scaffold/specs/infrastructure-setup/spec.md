## ADDED Requirements

### Requirement: Local environment starts with a single command
The system SHALL provide a `docker-compose.yml` such that `docker compose up --build` starts all required services: `postgres`, `redis`, `api`, `worker`, and `frontend`. All services SHALL be healthy and inter-connected without manual configuration steps beyond copying `.env.example` to `.env`.

#### Scenario: Full stack startup
- **WHEN** a developer runs `docker compose up --build` from the project root with a valid `.env` file
- **THEN** all five services SHALL start without errors and the API SHALL respond to `GET /health` at `http://localhost:4000/health`

### Requirement: Environment variables are documented
The repository SHALL contain a `.env.example` file listing every required and optional environment variable with a descriptive comment and a safe default value where applicable.

#### Scenario: New developer setup
- **WHEN** a developer copies `.env.example` to `.env` without modification
- **THEN** `docker compose up --build` SHALL start successfully in a default local configuration

### Requirement: Prisma schema is initialised
The repository SHALL contain a `prisma/schema.prisma` with a PostgreSQL datasource and Prisma client generator. An initial migration (`0000_initial`) SHALL exist so that `prisma migrate deploy` can be run idempotently.

#### Scenario: Database migration on first run
- **WHEN** `prisma migrate deploy` is run against a fresh PostgreSQL database
- **THEN** it SHALL apply the initial migration without errors and the database SHALL be ready for subsequent migrations
