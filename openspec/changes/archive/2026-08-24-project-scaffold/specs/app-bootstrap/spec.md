## ADDED Requirements

### Requirement: Application boots and serves HTTP
The NestJS application SHALL start successfully when `DATABASE_URL`, `REDIS_URL`, and `PORT` environment variables are set. It SHALL bind to the configured port and be ready to accept HTTP requests within 30 seconds of container start.

#### Scenario: Successful startup
- **WHEN** the API container starts with valid environment variables
- **THEN** the process SHALL log a startup message including the bound port and exit with no unhandled exceptions

#### Scenario: Missing required env var
- **WHEN** a required environment variable (e.g. `DATABASE_URL`) is absent
- **THEN** the application SHALL fail fast at startup with a descriptive error message and exit code non-zero
