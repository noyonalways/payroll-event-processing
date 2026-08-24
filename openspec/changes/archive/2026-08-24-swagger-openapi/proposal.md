# Proposal: Swagger / OpenAPI Documentation

## Why

Every endpoint in the payroll service is today discoverable only by reading source. There is no interactive test surface and no machine-readable contract. Swagger was slated for roadmap change 11 (`ci-and-docs`), but it is a small, self-contained unit that unblocks manual QA and client integration now. Pulling it forward lets the event-submission API be exercised in the browser ("Try it out") while the rest of change 11 (CI workflow, final README/diagram) stays in the queue untouched.

## What Changes

- Add `@nestjs/swagger` (^11) and always-on Swagger wiring — no environment toggle; the documentation is served in every `NODE_ENV` (development, test, production).
- Serve an interactive Swagger UI at `GET /api-docs` and the raw OpenAPI JSON document at `GET /api-docs-json` (routes already documented in `openspec/config.yaml`).
- Document `POST /events` fully: request schema referencing `CreateEventDto`, the required `Idempotency-Key` header, typed `201`/`400` responses, and named request-body examples for all three supported event types so "Try it out" is one click.
- Document `GET /health` with a typed `200` response.
- Expose component schemas for the three payload DTOs, the event-submission response, the health response, and the global structured error shape.

## Capabilities

### New Capabilities
- `api-documentation`: Interactive Swagger UI at `GET /api-docs` and raw OpenAPI JSON at `GET /api-docs-json`, describing all HTTP operations (event submission, health) with typed request/response schemas and request examples, reachable in every runtime environment.

### Modified Capabilities
<!-- none — no existing spec requirements change -->

## Impact

- **Code added**: `src/common/swagger/setup-swagger.ts`, `src/common/dto/error-response.dto.ts`, `src/events/dto/event-submission-response.dto.ts`, `src/events/dto/event-examples.ts`, `src/common/health/health-response.dto.ts`, `test/api-docs.e2e-spec.ts`.
- **Code modified**: `src/main.ts`, `src/events/dto/create-event.dto.ts`, the three payload DTOs in `src/events/dto/payloads/`, `src/events/events.controller.ts`, `src/common/health/health.controller.ts`.
- **Dependencies**: `@nestjs/swagger@^11` (runtime dependency — the API production image needs it to serve the docs).
- **Docs**: `openspec_roadmap.md`, `README.md`, `docs/architecture.md`.
- **Tests**: additive only; existing unit and e2e suites are untouched and must stay green.

## Non-goals

- No CI workflow changes (stays in change 11).
- No final README / architecture-diagram rewrite (stays in change 11).
- No authentication / API-key documentation (the service has none by design).
- No documentation of `GET /events` or `GET /events/:id` (change 8 — those endpoints do not exist yet).
- No environment toggle for Swagger — always on by design.
- No hand-authored OpenAPI YAML — the document is generated from code annotations.