# App Bootstrap

## Purpose

Ensure the NestJS API application starts successfully when the required configuration is present, binds to its configured port, and becomes ready to serve HTTP within a bounded time. It fails fast with a descriptive error when required environment variables are missing, so misconfiguration surfaces immediately at startup rather than at runtime.

## Requirements

### Requirement: Application boots and serves HTTP
The NestJS application SHALL start successfully when `DATABASE_URL`, `REDIS_URL`, `PORT`, and `AUTH_JWT_SECRET` environment variables are set. `AUTH_JWT_SECRET` SHALL be at least 32 characters and SHALL have no default value: the application SHALL fail fast when it is absent or too short, so a deployment can never start with an empty or guessable token-signing key. It SHALL bind to the configured port and be ready to accept HTTP requests within 30 seconds of container start.

#### Scenario: Successful startup
- **WHEN** the API container starts with valid environment variables, including an `AUTH_JWT_SECRET` of at least 32 characters
- **THEN** the process SHALL log a startup message including the bound port and exit with no unhandled exceptions

#### Scenario: Missing required env var
- **WHEN** a required environment variable (e.g. `DATABASE_URL`) is absent
- **THEN** the application SHALL fail fast at startup with a descriptive error message and exit code non-zero

#### Scenario: Missing signing key fails the boot
- **WHEN** the application starts without `AUTH_JWT_SECRET`
- **THEN** the application SHALL fail fast at startup with a descriptive error message and exit code non-zero, rather than starting and signing tokens with a default key

#### Scenario: Short signing key fails the boot
- **WHEN** the application starts with an `AUTH_JWT_SECRET` shorter than 32 characters
- **THEN** the application SHALL fail fast at startup with a descriptive error message and exit code non-zero
