# Design — minimal-frontend

## Context

The backend is complete: `POST /events` (mandatory `Idempotency-Key`, per-type validation, idempotent dedup) and `GET /events/{id}` (full lifecycle state + attempt trail) are shipped, Swagger documents both, CORS is globally enabled (`src/main.ts:33`), and the API runs on port 3000. The only UI is a static placeholder: `docker-compose.yml` mounts `docker/placeholder-index.html` into an `nginx:alpine` container on host port 5173, and `frontend/` contains just `.gitkeep`.

Key constraint: there is **no `GET /events` list endpoint** — roadmap change #8 (`event-status-api`) leaves it pending. A minimal frontend therefore cannot query "all events"; it must track what it has submitted from the browser and poll `GET /events/{id}` per event.

The project context (config.yaml) already commits to **React + Vite (minimal demo UI)** and a `frontend/` directory. Verified against current guidance: the `create-vite` React-TS template ships Vite 8.x + React 19.2.x, `dev`/`build`/`preview` scripts, and `VITE_`-prefixed env vars surfaced via `import.meta.env`.

## Goals / Non-Goals

**Goals:**
- A self-contained, dependency-light React + Vite + TypeScript demo UI under `frontend/` that can: submit all three event types with generated idempotency keys; show a live-polling list with lifecycle status badges; and show a detail view with the processing result and failure trail.
- Client-side tracking persisted in `localStorage` (no backend changes).
- Replace the docker-compose placeholder with a real multi-stage build so `docker compose up --build` serves the UI at `http://localhost:5173`.
- Small Vitest + React Testing Library suite for the API client, tracking/polling logic, and submit form.

**Non-Goals:**
- No new backend endpoints (no `GET /events`, no `/history`) — roadmap change #8 owns those; the UI is built to consume only existing endpoints.
- No npm workspaces restructure of the root package; no new root dependencies.
- No router, no state-management library, no server-side rendering. Base UI is a *headless* primitive library (not a pre-styled framework); all visual styling is Tailwind.
- No backend test changes (roadmap #10 owns the consolidated test suite).
- No authentication.

## Decisions

### D1 — Stack: Vite + React + TypeScript (Tailwind CSS v4 + Base UI, no router)
A single-page app in `frontend/` scaffolded from the official React-TS template (Vite 8, React 19.2, `@vitejs/plugin-react`). No `react-router`: the app is one screen with a two-pane layout (list + detail panel) driven by a `selectedId` state. Styling is **Tailwind CSS v4** (via the `@tailwindcss/vite` plugin and `@import "tailwindcss"` in `src/index.css`, with `@theme` tokens) using headless **Base UI** primitives (`@base-ui-components/react`: `Select`, `Input`, `Button`, `Field`) dressed with Tailwind utility classes. Per-state status-badge colors are `@theme` tokens tuned to stay readable in light and dark themes.

> **Deviation note (2026-08-26):** the original plan specified plain CSS with no UI library. Per the maintainer's direction, the styling stack is Tailwind CSS v4 + Base UI; no pre-styled component framework is used

- **Alternatives**: Next.js — heavier than a demo needs (no SSR requirement, and config.yaml pins "React + Vite"); adding `react-router` — unnecessary for a single screen with a detail panel.
- **Reliability concept**: none directly; keeps the change minimal so robustness work stays visible.

**Files created:** `frontend/package.json`, `frontend/vite.config.ts` (+ `@tailwindcss/vite` plugin), `frontend/vitest.config.ts`, `frontend/tsconfig.json`, `frontend/tsconfig.app.json` (Vite-native split, type-strict), `frontend/index.html`, `frontend/.gitignore`, `frontend/src/main.tsx`, `frontend/src/index.css` (Tailwind entry + `@theme` tokens), `frontend/src/vite-env.d.ts`.

### D2 — Module boundary: self-contained `frontend/` package (not npm workspaces)
`frontend/` gets its own `package.json` with its own `node_modules`/lockfile. The root `package.json` gains only three thin convenience scripts — `dev:frontend`, `build:frontend`, `test:frontend` — via `npm --prefix frontend run …`.

- **Alternatives**: convert the repo to npm workspaces ("monorepo-lite" is mentioned in config.yaml). Rejected: workspaces hoist dependencies and would pull the frontend into the root `npm ci`/build/lint/test flows, risking interference with the NestJS build and tsconfig resolution; a workspace boundary also complicates the independent Docker build context.
- **Reliability concept**: clean isolation; nothing in the frontend can break backend worker/queue behavior.

**Files modified:** root `package.json` (scripts only). `frontend/package-lock.json` generated. Root `.gitignore` already ignores `node_modules/` and `dist/` at any depth.

### D3 — API integration: direct CORS fetch to `VITE_API_URL`, no proxy
A typed client module calls the API directly from the browser. Base URL comes from `import.meta.env.VITE_API_URL`, defaulting to `http://localhost:3000` in `frontend/.env.example` and via build-time `ARG VITE_API_URL` in the Dockerfile. CORS is already enabled globally on the API, so no proxy is needed in either dev mode (Vite :5173) or the container (nginx :5173 → API published on host :3000).

- **Alternatives**: nginx reverse proxy (`/api` → `api:3000`) in the frontend container. Rejected: the API has no `/api` path prefix, so the proxy needs a rewrite rule; a direct fetch with an existing CORS-enabled API is simpler, transparent, and already works for the dev server. Bake-vs-runtime trade-off noted in Risks.
- **Reliability concept**: idempotency (#2) is exercised at the client boundary — the client always sends a fresh UUID `Idempotency-Key` on new submissions.

**Files created:** `frontend/src/api/events.ts`, `frontend/src/lib/types.ts`, `frontend/.env.example`.

### D4 — Event tracking + live polling (client-side, no list endpoint)
Because no `GET /events` exists, a `useEventTracker` hook (in `src/lib/useEventTracker.ts`) owns the tracked list: state entries keyed by event id, each holding `{ id, eventType, employeeId, lastStatus, attempts, submittedAt, idempotencyKey, error? }`, persisted to `localStorage` under `payroll.events.tracked.v1`. A single 3-second `setInterval` ticks in `useEffect`; each tick fires `GET /events/{id}` (via `fetchEventStatus`) for every entry whose `lastStatus` is non-terminal, using `Promise.allSettled`, and merges results back into state + storage. Terminal events (`success`/`failed`) are excluded from subsequent polls. A row whose poll fails (network error or 404) is marked `unavailable` and skipped next tick. A "Clear list" action drops the storage key.

- **Alternatives**: server-sent events/WebSocket — the API offers no push channel; polling is one interval and matches the roadmap's "live-polling" wording. Poll every row synchronously — rejected, `allSettled` parallelizes and isolates failures.
- **Reliability concept**: crash recovery (#4) and temp-vs-permanent (#1) become observable — the UI self-heals (badge returns to `queued` between backoff attempts, then resolves), and it keeps working through an API/worker restart.
- **File structure:** `frontend/src/lib/useEventTracker.ts` (reducer + effect), `frontend/src/lib/status.ts` (terminal-state helpers + badge formatting), `frontend/src/lib/storage.ts` (localStorage read/merge/write), `frontend/src/lib/eventTypes.ts` (per-type field specs).

### D5 — Per-type submission form with generated idempotency key
`src/components/SubmitForm.tsx` renders an event-type select plus dynamic fields sourced from `src/lib/eventTypes.ts` — a client-side mirror of the backend's `payload-registry`:

| Event type | Fields |
|---|---|
| `BANK_ACCOUNT_CHANGE` | `employeeId`, `effectiveDate`, `iban` |
| `ADDRESS_CHANGE` | `employeeId`, `effectiveDate`, `street`, `city`, `postalCode`, `country` |
| `SALARY_CHANGE` | `employeeId`, `effectiveDate`, `newSalary`, `currency` |

Client-side checks (required fields present, `newSalary > 0`, IBAN non-empty) block obviously incomplete submissions, but the API remains the authority: a `400` response (structured `ErrorResponseDto`: `statusCode`, `message`, `error`, `timestamp`, `path`) is parsed and surfaced inline, preserving entered values. Each submit generates `crypto.randomUUID()` for the `Idempotency-Key` header and builds `{ eventType, payload }`. On `201` the returned `{ id, status }` is added to the tracker.

- **Reliability concept**: idempotency (#2) — fresh key per submission; the tracker records the key used per event for traceability.
**Files created:** `frontend/src/components/SubmitForm.tsx`, `frontend/src/components/field-specs.ts` (or folded into `eventTypes.ts`).

### D6 — List, badges, and detail panel
- `src/components/EventList.tsx`: rows for each tracked entry — event id (truncated), `eventType`, `employeeId`, `sequence` (when known), `StatusBadge`, attempt count; clicking selects an id.
- `src/components/StatusBadge.tsx`: status → label/color mapping for `received / queued / processing / success / failed` plus an `unavailable` state; explicit color per state so lifecycle transitions are legible at a glance.
- `src/components/EventDetail.tsx`: detail panel for the selected id rendering the full `GET /events/{id}` body — `payload` (pretty-printed JSON), `sequence`, `createdAt`/`updatedAt`/`processedAt`, `result` on success, and the `attempts` array ordered ascending by `attemptNumber`, each showing `attemptNumber`, `status`, `errorType`, `failedReason`, `result`, `createdAt`. Selecting a row whose last-known data is stale will re-poll on next tick; the detail panel also does a targeted refresh.

- **Reliability concept**: exactly-once outcome (#5) and temp-vs-permanent (#1) are visible — `SUCCESS` attempt vs `FAILED` attempt with `errorType` and `failedReason`; per-employee ordering (#6) is shown via `sequence`.
**Files created:** the three components above plus `frontend/src/App.tsx` (composition + `selectedId` state).

### D7 — Testing: Vitest + React Testing Library
`frontend/vitest.config.ts` (jsdom environment, `setupFiles: src/test/setup.ts`), `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`. Tests are written alongside implementation:

- `src/api/events.test.ts` — mocked `fetch`: header presence + URL, `201` parsing, `400` ErrorResponseDto normalization, network-failure path.
- `src/lib/eventTypes.test.ts` — per-type field sets match the `event-submission` contract.
- `src/lib/status.test.ts` — terminal detection + badge mapping.
- `src/lib/useEventTracker.test.ts` — fake timers: polling stops at terminal state; failed poll marks row unavailable; reload restores from localStorage.
- `src/components/SubmitForm.test.tsx` — fields swap per type; required-field block; API 400 surfaced with values preserved; fresh key per submit (spy on `crypto.randomUUID`).
- `src/components/EventList.test.tsx` / `EventDetail.test.tsx` — row render, selection opens detail, attempts render in order.

- **Alternatives**: reuse root Jest (ts-jest) — rejected: it has no jsdom/jsx preset already configured, and adding it would entangle frontend dev-deps with the backend suite; Vitest is Vite-native and keeps `frontend/` self-contained.
**Files created:** `frontend/vitest.config.ts`, `frontend/src/test/setup.ts`, plus the specs above. Root `package.json` gains `test:frontend`.

### D8 — Containerization: `docker/Dockerfile.frontend` + updated compose service
Multi-stage `docker/Dockerfile.frontend` (build context = repo root `.`, consistent with `Dockerfile.api`/`Dockerfile.worker`):

```
FROM node:20-alpine AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM nginx:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
```

`docker/nginx.conf` is the SPA-safe static config (`try_files $uri $uri/ /index.html;`). `docker-compose.yml` replaces the placeholder service with a build:

```yaml
frontend:
  build:
    context: .
    dockerfile: docker/Dockerfile.frontend
    args:
      VITE_API_URL: ${VITE_API_URL:-http://localhost:3000}
  container_name: payroll_frontend
  restart: unless-stopped
  ports: ["5173:80"]
  depends_on:
    api:
      condition: service_healthy
```

Remove: the placeholder volume mounts, `docker/nginx-placeholder.conf`, `docker/placeholder-index.html`, `frontend/.gitkeep`. `docker/.dockerignore` already excludes `frontend/node_modules` + `frontend/dist`.

- **Reliability concept**: the containerized demo lets a reviewer see recovery/retry behavior live (crash a worker, watch the badge recover).
**Files created:** `docker/Dockerfile.frontend`, `docker/nginx.conf`. **Files modified:** `docker-compose.yml`. **Files removed:** as above.

## DB / Schema Changes

**None.** This change is frontend-only. No Prisma schema, column, index, constraint, or migration changes. The `event-submission` and `event-status-api` capabilities are consumed as-is.

## Risks / Trade-offs

- [Vite bake-time `VITE_API_URL`] → rebuild needed to point at a different API origin. Mitigation: a sensible default (`http://localhost:3000`), documented `frontend/.env.example`, and compose `ARG` so deployments can override without editing code.
- [Polling load] → every non-terminal event is polled every 3 s. Mitigation: `allSettled` concurrency, polling stops at terminal states, and the list is browser-local so scale stays tiny; interval is a single named constant for easy tuning.
- [`localStorage` drift after DB reset] → tracked ids may 404. Mitigation: 404 marks the row `unavailable` (per spec scenario) rather than poisoning the list; a "Clear list" action exists.
- [No backend list endpoint] → events submitted elsewhere are invisible. Mitigation: accepted, explicitly scoped (roadmap #8 owns `GET /events`); detail panel still shows any id the user navigates to (future hook point).
- [react-router omitted] → no URL-based deep-linking into an event. Trade-off accepted for the demo; adding a router later is a small, isolated change.
- [Base UI `1.0.0-rc` + Tailwind v4] → near-release headless package. Because styling is entirely our Tailwind classes, a Base UI API break affects only the few primitives used (`Select`, `Input`, `Button`, `Field`); pinned by lockfile.

## Migration Plan

No data migration. Deployment steps:

1. Implement the frontend (dev-mode first; API already running on :3000).
2. `npm --prefix frontend run build` + `npm --prefix frontend run test` to verify.
3. Swap the compose `frontend` service to the build image; `docker compose up --build` — the API/worker containers are untouched, so the running stack ports are unchanged and the placeholder is simply replaced.
4. Rollback: revert the compose service block + delete the new files; the previous image/placeholder remains in git history.

## Open Questions

- Exact Vite 8 minor and React 19 minor to pin: resolve at implementation time from `npm create vite` output (template default) — no design impact.
- Whether the detail panel should deep-link per row once a router is added: deferred, non-blocking.