## 1. Frontend scaffold

- [x] 1.1 Scaffold the `frontend/` app from the official create-vite React-TS template (`npm create vite@latest frontend -- --template react-ts`, trimmed to the files listed in design D1). Verify with `npm --prefix frontend install` and `npm --prefix frontend run build`.
- [x] 1.2 Add test + styling dev dependencies to `frontend/package.json` — Vitest + Testing Library (`vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`) and Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/vite`) + Base UI (`@base-ui-components/react`); add `frontend/vitest.config.ts` (jsdom, `setupFiles: src/test/setup.ts`), plug `@tailwindcss/vite` into `frontend/vite.config.ts`, and add `frontend/src/test/setup.ts`; add `test` and `test:run` scripts. Verify `npm --prefix frontend run test` runs a smoke spec.
- [x] 1.3 Add root `package.json` convenience scripts `dev:frontend`, `build:frontend`, `test:frontend` via `npm --prefix frontend run …`.
- [x] 1.4 Add `frontend/.env.example` documenting `VITE_API_URL` (default `http://localhost:4000`) with a comment.

## 2. API client and types (consumes existing endpoints)

- [x] 2.1 Add `frontend/src/lib/types.ts` — `EventType` union, per-type payload interfaces, `EventSubmissionResponse`, `EventStatusResponse`, `EventAttempt`, and the `ErrorResponseDto` mirror (`statusCode`, `message`, `error`, `timestamp`, `path`).
- [x] 2.2 Add `frontend/src/api/events.ts` — `submitEvent` (POST `{ eventType, payload }` to `${VITE_API_URL}/events` with a fresh UUID in the `Idempotency-Key` header) and `fetchEventStatus` (GET `/events/{id}`); normalize non-2xx into a typed `ApiError` carrying the structured error body; export `API_BASE_URL` from `import.meta.env.VITE_API_URL`.
- [x] 2.3 Add `frontend/src/api/events.test.ts` (alongside 2.2, not after) — mocked `fetch`: correct URL + `Idempotency-Key` header on submit, `201` parsing, `400` normalized into `ApiError`, network-failure path.

## 3. Event-type field specs and status helpers

- [x] 3.1 Add `frontend/src/lib/eventTypes.ts` — per-type field specs (`BANK_ACCOUNT_CHANGE` → `employeeId`/`effectiveDate`/`iban`; `ADDRESS_CHANGE` → +`street`/`city`/`postalCode`/`country`; `SALARY_CHANGE` → +`newSalary`/`currency`) as the single source for form rendering and payload construction.
- [x] 3.2 Add `frontend/src/lib/status.ts` — badge label/color mapping for `received|queued|processing|success|failed` plus `unavailable`, and `isTerminal(status)` (true for `success`/`failed`).
- [x] 3.3 Add `frontend/src/lib/eventTypes.test.ts` and `frontend/src/lib/status.test.ts` (alongside 3.1/3.2) — field sets match the `event-submission` contract; terminal detection correct.

## 4. Event tracking and live polling (reliability-critical: #1 retry visibility, #4 crash recovery)

- [x] 4.1 Add `frontend/src/lib/storage.ts` — load/merge/save the tracked list under `localStorage` key `payroll.events.tracked.v1`; tolerate missing/corrupt entries. **[reliability-critical]** The tracker never loses a submitted event on reload, so a worker restart mid-lifecycle is never lost from the UI.
- [x] 4.2 Add `frontend/src/lib/useEventTracker.ts` — reducer state (entries keyed by event id: `id`, `eventType`, `employeeId`, `lastStatus`, `attempts`, `sequence?`, `submittedAt`, `idempotencyKey`, `error?`) + a 3 s interval effect that polls `fetchEventStatus` via `Promise.allSettled` for every non-terminal entry, merges results into state and storage, stops polling terminal entries, marks a failing row `unavailable`, and exposes `clearList` / `recordSubmission`. **[reliability-critical]** Poll-stop on `isTerminal` reflects the exactly-once terminal contract (#5); surviving a failed poll preserves crash-recovery visibility (#4).
- [x] 4.3 Add `frontend/src/lib/useEventTracker.test.ts` (alongside 4.2) — fake timers: poll stops at terminal state; a failed poll marks the row `unavailable` and the rest of the list keeps polling; entries restore from `localStorage` on mount; `recordSubmission` adds a row with the supplied idempotency key.

## 5. UI components

- [x] 5.1 Add `frontend/src/App.tsx` — two-pane layout (list + detail), `selectedId` state, tracking hook wired to the submit handler, and a "Clear list" action wired to `clearList`.
- [x] 5.2 Add `frontend/src/components/SubmitForm.tsx` — event-type selector, dynamic fields from `eventTypes.ts`, client-side required-field checks (incl. `newSalary > 0`), `crypto.randomUUID()` key per submission, inline API `400` display that preserves entered values, and a call to `recordSubmission` on `201`.
- [x] 5.3 Add `frontend/src/components/StatusBadge.tsx` and `frontend/src/components/EventList.tsx` — rows with truncated id, `eventType`, `employeeId`, `sequence?`, badge, and attempt count; row click sets the selected id.
- [x] 5.4 Add `frontend/src/components/EventDetail.tsx` — renders the full `GET /events/{id}` body for the selected id: payload (pretty-printed JSON), `sequence`, `createdAt`/`updatedAt`/`processedAt`, `result`, and the `attempts` array rendered ascending by `attemptNumber` with per-attempt `status`, `errorType`, `failedReason`, `result`, `createdAt`; handles the `unavailable`/404 case.
- [x] 5.5 Add component tests (alongside 5.2–5.4): `SubmitForm.test.tsx` (fields swap per type, empty-required blocks submit, API 400 keeps values, fresh key per submit), `EventList.test.tsx` (row render + selection), `EventDetail.test.tsx` (success shows result/`processedAt`, failed shows `failedReason`/`errorType`, attempts ascend, unavailable state).

## 6. Styling

- [x] 6.1 Add `frontend/src/index.css` — Tailwind v4 entry (`@import "tailwindcss"`) with `@theme` tokens, including a distinct, readable color per status badge (readable in light/dark); dress the components with Tailwind classes + Base UI primitives (`Select`, `Input`, `Button`, `Field`) so the two-pane demo layout is presentable without a pre-styled framework.

## 7. Containerization (replaces placeholder)

- [x] 7.1 Add `docker/Dockerfile.frontend` (multi-stage: `node:20-alpine` build with `ARG VITE_API_URL` default `http://localhost:4000` → `nginx:alpine`) and `docker/nginx.conf` (`try_files $uri $uri/ /index.html;`).
- [x] 7.2 Update `docker-compose.yml` `frontend` service to `build: { context: ., dockerfile: docker/Dockerfile.frontend, args: { VITE_API_URL: ${VITE_API_URL:-http://localhost:4000} } }`, remove the placeholder volume mounts, keep port `5173:80`, add `depends_on: api: service_healthy`.
- [x] 7.3 Remove `docker/nginx-placeholder.conf`, `docker/placeholder-index.html`, and `frontend/.gitkeep`.
- [x] 7.4 Build and boot the full stack (`docker compose build frontend`, then `docker compose up --build`); smoke-check that `http://localhost:5173` serves the app and a submission from it reaches the API (spec scenario "Docker compose serves the real UI").

## 8. Verification

- [x] 8.1 Run `npm --prefix frontend run test` (all green) and `npm --prefix frontend run build` (no TS errors); confirm root `npm run lint:check` and root tests are unaffected.
- [x] 8.2 Manual smoke against a running API — ✅ verified 2026-08-26 against the live compose stack (API :3000, worker, frontend :5173, Postgres+Redis): one event of each type submitted (BANK→`EMP-DEMO-SUCCESS`, ADDRESS→`EMP-DEMO-RECOVER`, SALARY→`EMP-DEMO-PERMANENT`) and polled to terminal; confirmed `success` (attempt 1 SUCCESS), `success` at attempt 3 after retries, and `failed`/PERMANENT at attempt 1; detail payload shows `processedAt`/`result` on success and `failedReason`/`errorType` on failure (attempts ascending). Frontend served at :5173 (`<title>Payroll Events</title>`); `/health` ok. Reload-restores-and-resumes and API-stop→`unavailable` (without freezing the list) are UI behaviors asserted by `useEventTracker.test.ts` + component tests (9 files, 52 tests green)