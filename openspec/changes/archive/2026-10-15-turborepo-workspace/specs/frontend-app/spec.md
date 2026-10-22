# Spec Delta

## MODIFIED Requirements

### Requirement: The API location is configurable and the app is containerized
The UI SHALL read the API base URL from a `VITE_API_URL` build-time environment variable, defaulting to `http://localhost:4000`, and SHALL use it as the base origin for all HTTP requests. The UI SHALL be a workspace application owning its own Dockerfile, built with the workspace root as its build context, and the repository SHALL ship a `docker-compose.yml` `frontend` service that builds and serves the UI such that `docker compose up --build` serves it at `http://localhost:5173` alongside the API, satisfying the `infrastructure-setup` five-service startup requirement.

#### Scenario: Custom API base URL
- **WHEN** the frontend is built with `VITE_API_URL` set to a non-default origin
- **THEN** all API requests SHALL target that origin

#### Scenario: Docker compose serves the real UI
- **WHEN** a developer runs `docker compose up --build` with the API healthy
- **THEN** `http://localhost:5173` SHALL serve the built demo UI and submissions from it SHALL reach the API

#### Scenario: The UI is built and served as a workspace member
- **WHEN** the UI's image is built
- **THEN** the build SHALL install the UI application's dependencies from the workspace lockfile and produce the same static bundle as a host build of the same application, so the containerised UI and a locally served UI are the same artifact
