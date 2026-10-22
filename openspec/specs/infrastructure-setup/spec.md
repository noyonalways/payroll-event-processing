# Infrastructure Setup

## Purpose

Provide a reproducible local development environment that starts the full stack (PostgreSQL, Redis, API, worker, and frontend) with a single command, documents all required and optional environment variables, and ships a Prisma schema with an initialised migration so the database can be deployed idempotently.

## Requirements

### Requirement: Local environment starts with a single command
The system SHALL provide a `docker-compose.yml` such that `docker compose up --build` starts all required services: `postgres`, `redis`, `api`, `worker`, and `frontend`. Each application SHALL be built from its own Dockerfile with the workspace root as the build context, so a single application image installs only the dependencies that application needs from the workspace lockfile. All services SHALL be healthy and inter-connected without manual configuration steps beyond copying `.env.example` to `apps/api/.env.development`.

#### Scenario: Full stack startup
- **WHEN** a developer runs `docker compose up --build` from the workspace root with a valid `apps/api/.env.development` file
- **THEN** all five services SHALL start without errors and the API SHALL respond to `GET /health` at `http://localhost:4000/health`

#### Scenario: An application image builds from its own Dockerfile
- **WHEN** a single application's image is built
- **THEN** the build SHALL use that application's Dockerfile with the workspace root as its context, and SHALL install dependencies from the workspace lockfile rather than from a package-local one

#### Scenario: Container topology is unchanged by the workspace layout
- **WHEN** the stack is running
- **THEN** the services SHALL reach each other over the compose network by service name, and the published host ports SHALL be unchanged from the pre-workspace topology

### Requirement: Environment variables are documented
The repository SHALL contain an `apps/api/.env.example` file listing every required and optional environment variable with a descriptive comment and a safe default value where applicable. The real stage files (`.env.<NODE_ENV>`) SHALL live with the API app (`apps/api/.env.<NODE_ENV>`), and the workspace root SHALL NOT carry stage environment files. Every backend entrypoint SHALL resolve `apps/api/.env.<NODE_ENV>` to an absolute path so the same file loads regardless of the directory the app is launched from, and SHALL refuse to start, naming that file, when it is absent and the required variables were not injected through the environment. The Prisma CLI SHALL read `packages/database/.env`.

#### Scenario: New developer setup
- **WHEN** a developer copies `apps/api/.env.example` to `apps/api/.env.development` without modification
- **THEN** `docker compose up --build` SHALL start successfully in a default local configuration

#### Scenario: An app reads the app-owned stage file from any invocation directory
- **WHEN** a backend app is launched from the workspace root or from its own directory
- **THEN** it SHALL load configuration from `apps/api/.env.<NODE_ENV>`, and no stage environment file SHALL be required anywhere else in the workspace

#### Scenario: A missing stage file fails loudly
- **WHEN** a backend app is started without its stage file and without injected environment variables
- **THEN** startup SHALL fail naming the file it looked for, rather than the app starting with unset configuration

#### Scenario: The container path needs no env file
- **WHEN** a container starts with the configuration injected as environment variables and no stage file present
- **THEN** the app SHALL start normally using the injected values

### Requirement: Prisma schema is initialised
The repository SHALL contain a `prisma/schema.prisma` with a PostgreSQL datasource and Prisma client generator, owned by a single workspace package that also owns the migration history, so migrations have exactly one home. An initial migration (`0000_initial`) SHALL exist so that `prisma migrate deploy` can be run idempotently. The schema, the migrations, and the database client SHALL all live in that one package, and every application SHALL consume them as a declared workspace dependency rather than by reaching into the package's files.

#### Scenario: Database migration on first run
- **WHEN** `prisma migrate deploy` is run against a fresh PostgreSQL database
- **THEN** it SHALL apply the initial migration without errors and the database SHALL be ready for subsequent migrations

#### Scenario: Migrations run from the owning package
- **WHEN** migrations are applied, whether from a developer machine or from a container entrypoint
- **THEN** they SHALL be applied using the schema path inside the package that owns it, so the same migration history is used from every entry point

#### Scenario: Applications consume the database package
- **WHEN** an application writes or reads persisted data
- **THEN** it SHALL do so through the database package's exported client, and SHALL NOT import generated client files by a relative path from outside that package
