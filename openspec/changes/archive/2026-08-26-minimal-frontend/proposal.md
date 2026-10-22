## Why

The backend (NestJS API + BullMQ worker + Postgres/Redis) is fully functional and every reliability property — idempotency, per-employee ordering, retry/failure handling, crash recovery — is demonstrable through `POST /events` and `GET /events/{id}`. But the only user-facing surface is a static nginx placeholder, so reviewing the system requires hand-crafting cURL requests. A minimal demo UI makes the event lifecycle explorable and the reliability concepts visible end-to-end.

## What Changes

- Scaffold a minimal **React + Vite + TypeScript** app under `frontend/` with its own `package.json` (self-contained; the root package.json is not converted to npm workspaces).
- **Submit form**: event-type selector (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`) that swaps in per-type fields matching the `event-submission` contract, auto-generates an `Idempotency-Key` (UUID) per submission, surfaces per-field validation errors, and shows the 201 id/status on success.
- **Event list with live-polling status badges**: a client-side list that tracks events submitted from this browser (persisted in `localStorage`), polls `GET /events/{id}` for every non-terminal event on a short interval, and renders lifecycle status badges (`received → queued → processing → success | failed`) with attempt counts.
- **Event detail view**: selecting a list row opens a detail panel showing the full `GET /events/{id}` response — payload, per-employee `sequence`, timestamps, `result`, `failedReason`/`errorType`, and the ordered attempt trail.
- **API base URL config** via `VITE_API_URL` (default `http://localhost:4000`). CORS is already enabled globally on the API, so the Vite dev server can call it directly.
- **Containerization**: add `docker/Dockerfile.frontend` (multi-stage Vite build → nginx) and update the `frontend` service in `docker-compose.yml` to build from it, removing the placeholder mounts (`docker/nginx-placeholder.conf`, `docker/placeholder-index.html`).
- **Frontend tests**: Vitest + React Testing Library covering the API client module, status/attempt formatting, and submit-form behaviour.
- Root `package.json`: add `dev:frontend` and `build:frontend` convenience scripts.
- **No backend changes** — no new endpoints, no CORS changes, no spec-level API modifications.

## Non-goals

- **`GET /events` list endpoint** — deliberately out of scope; the roadmap (change #8, `event-status-api`) still lists it as pending, so the frontend tracks what it has submitted rather than querying a backend list.
- **`GET /events/{id}/history`** — out of scope for the same reason.
- **Authentication, multi-user, or server-side list persistence** — demo-only, single browser session.
- **A pre-styled component framework or design system** — styling is Tailwind CSS v4 + headless Base UI primitives, minimal dependencies (no router, no state-management library).
- **Backend test-suite expansion** — that is roadmap change #10 (`test-suite`), tracked separately.

## Capabilities

### New Capabilities

- `frontend-app`: Vite + React demo UI that submits typed payroll events, renders a live-polling event list with lifecycle status badges, and shows an event detail view with processing result and failure trail — configured via `VITE_API_URL` and containerized in docker-compose.

### Modified Capabilities

- (none — the infra-setup requirement "`docker compose up --build` starts all five services" is unchanged; replacing the placeholder frontend container is an implementation detail under that requirement.)

## Impact

- **Code added**: `frontend/` — `package.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/api/events.ts` (typed client), `src/components/*` (SubmitForm, EventList, StatusBadge, EventDetail), `src/lib/*` (types, formatting, storage), `src/test/*` (Vitest setup + specs), CSS.
- **Code modified**: `docker-compose.yml` (frontend service builds the real app), root `package.json` (dev/build scripts).
- **Code removed**: `frontend/.gitkeep`, `docker/nginx-placeholder.conf`, `docker/placeholder-index.html`.
- **New infrastructure files**: `docker/Dockerfile.frontend`, `docker/nginx.conf`.
- **Dependencies**: React, Vite, TypeScript, Vitest, `@testing-library/react`, Tailwind CSS v4, `@base-ui-components/react` — all declared in `frontend/package.json` only.
- **API surface**: unchanged — consumes existing `POST /events` (mandatory `Idempotency-Key` header) and `GET /events/{id}`.
- **Reliability concepts touched**: idempotency (key handling), crash recovery + retry visibility (polling/attempt display), exactly-once outcome display (success vs failed result rendering).

## Reference

- Roadmap item #9 (`minimal-frontend`), #8 (`event-status-api` — list/history remain pending), config.yaml folder layout (`frontend/` — Vite + React minimal demo).