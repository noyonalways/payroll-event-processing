# Spec Delta

## MODIFIED Requirements

### Requirement: Local environment starts with a single command
The system SHALL provide a `docker-compose.yml` such that `docker compose up --build` starts all required services: `postgres`, `redis`, `api`, `worker`, and `frontend`. Each application SHALL be built from its own Dockerfile with the workspace root as the build context, so a single application image installs only the dependencies that application needs from the workspace lockfile. All services SHALL be healthy and inter-connected without manual configuration steps beyond copying `.env.example` to `.env.development`.

#### Scenario: Full stack startup
- **WHEN** a developer runs `docker compose up --build` from the workspace root with a valid `.env.development` file
- **THEN** all five services SHALL start without errors and the API SHALL respond to `GET /health` at `http://localhost:3000/health`

#### Scenario: An application image builds from its own Dockerfile
- **WHEN** a single application's image is built
- **THEN** the build SHALL use that application's Dockerfile with the workspace root as its context, and SHALL install dependencies from the workspace lockfile rather than from a package-local one

#### Scenario: Container topology is unchanged by the workspace layout
- **WHEN** the stack is running
- **THEN** the services SHALL reach each other over the compose network by service name, and the published host ports SHALL be unchanged from the pre-workspace topology

### Requirement: Environment variables are documented
The repository SHALL contain a `.env.example` file at the workspace root listing every required and optional environment variable with a descriptive comment and a safe default value where applicable. Every workspace member SHALL read its configuration from these root files, so a variable is documented in exactly one place and no member carries its own copy of the shared set.

#### Scenario: New developer setup
- **WHEN** a developer copies `.env.example` to `.env.development` without modification
- **THEN** `docker compose up --build` SHALL start successfully in a default local configuration

#### Scenario: A member reads the documented root file
- **WHEN** a workspace member is started from the workspace root or from its own directory
- **THEN** it SHALL load configuration from the root environment file for the active environment, and SHALL NOT require a member-local copy of that file

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
