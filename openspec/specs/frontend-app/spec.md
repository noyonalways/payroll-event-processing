# Frontend App

## Purpose

Provide a minimal React + Vite demo UI that makes the payroll event processing service explorable: submit typed payroll events with a generated `Idempotency-Key`, watch them progress `received → queued → processing → success | failed` through live polling of `GET /events/{id}`, and inspect the processing result and failure trail for a selected event — so the service's reliability behaviour (idempotency, retries, exactly-once outcome) is visible end-to-end.

## Requirements

### Requirement: The UI can submit each supported event type

The system SHALL provide a submission form that targets `POST /events` with a mandatory `Idempotency-Key` header and an `Authorization: Bearer <accessToken>` header carrying the signed-in user's access token. For each supported event type (`BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE`, `DEPARTMENT_CHANGE`) the form SHALL render exactly the required fields defined for that type by the `event-submission` capability, and SHALL construct the request body as `{ "eventType": <type>, "payload": { <fields> } }`. The form's `employeeId` field SHALL be backed by the `employee-directory`: it SHALL offer the organization's **active** employees (fetched from `GET /employees?active=true`, with the seeded `EMP-DEMO-*` entries included) and SHALL NOT accept an arbitrary unlisted value; selecting a demo scenario SHALL pre-fill that scenario's demo employee. Every submit SHALL generate a fresh UUID as the `Idempotency-Key` header value. On HTTP `201` the UI SHALL display the returned `id` and `status` and add the event to the tracked list. On HTTP `400` or `422` the UI SHALL surface the structured error message without losing the entered values. A submission SHALL only be possible while a session is active; the submission form SHALL NOT be reachable without one.

#### Scenario: Submit BANK_ACCOUNT_CHANGE
- **WHEN** the signed-in user selects `BANK_ACCOUNT_CHANGE`, picks an employee in the directory-backed `employeeId` field, fills `effectiveDate` and `iban`, and submits
- **THEN** the UI SHALL send `POST /events` with body `{ "eventType": "BANK_ACCOUNT_CHANGE", "payload": { "employeeId": …, "effectiveDate": …, "iban": … } }`, an `Idempotency-Key` header, and the access token, display the returned `{ id, status }`, and add the event to the tracked list

#### Scenario: Employee field lists directory employees
- **WHEN** the signed-in user opens the submission form after their organization registered employees
- **THEN** the `employeeId` field SHALL offer exactly the organization's active employees — not a free-text input — including the five `EMP-DEMO-*` entries

#### Scenario: Demo scenario pre-fills its demo employee
- **WHEN** the user picks a demo scenario in the selector
- **THEN** the form SHALL pre-fill the matching `EMP-DEMO-*` employee along with the scenario's sample field values

#### Scenario: Fields are swapped per event type
- **WHEN** the user selects `ADDRESS_CHANGE` and then `SALARY_CHANGE`
- **THEN** the form SHALL render `street`, `city`, `postalCode`, `country` for `ADDRESS_CHANGE` and `newSalary`, `currency` for `SALARY_CHANGE`, with the employee picker and `effectiveDate` present for both, matching the `event-submission` field contract

#### Scenario: Missing required field is blocked before submitting
- **WHEN** the user attempts to submit with a required field of the selected type left empty
- **THEN** the UI SHALL show a field-level validation message and SHALL NOT send a request

#### Scenario: API validation error is surfaced
- **WHEN** the API responds `400` (for example a malformed IBAN or an unknown field)
- **THEN** the UI SHALL display the structured error message and keep the entered values editable

#### Scenario: An employee archived under the user is surfaced
- **WHEN** the API responds `422` because the employee the user picked was archived before the submit
- **THEN** the UI SHALL display the structured error message referencing `employeeId` and keep the entered values editable

#### Scenario: Fresh Idempotency-Key per submission
- **WHEN** the user submits two events in sequence
- **THEN** the two requests SHALL carry different `Idempotency-Key` header values

#### Scenario: Submission form is unavailable without a session
- **WHEN** no session is active
- **THEN** the UI SHALL present the sign-in/registration step instead of the submission form and SHALL NOT allow a submission to be sent

### Requirement: Users can trigger recovery actions from the event list

The UI SHALL offer a retry action on `failed` rows and a cancel action on `queued` or `received` rows, calling the corresponding `event-recovery` endpoints with the session token and no `Idempotency-Key` header.

#### Scenario: Failed row offers retry
- **WHEN** the user is shown a row whose status is `failed`
- **THEN** the UI SHALL offer a retry action that, when confirmed, calls `POST /events/{id}/retry` and on success shows the row as `queued` again and keeps it tracking live until a terminal state (via the event stream, or the polling fallback while the stream is disconnected)

#### Scenario: Pending row offers cancel
- **WHEN** the user is shown a row whose status is `queued` or `received`
- **THEN** the UI SHALL offer a cancel action that, when confirmed, calls `POST /events/{id}/cancel` and on success shows the row as `cancelled` with no further tracking

#### Scenario: Terminal rows offer no actions
- **WHEN** a row's status is `success` or `cancelled`
- **THEN** the UI SHALL NOT offer a retry or cancel action on that row

### Requirement: Recovery actions confirm, then update the row in place

The UI SHALL ask for confirmation before sending a recovery action. On success the UI SHALL update the row from the response without a manual refresh: a retried row re-enters live tracking (stream-driven, or the polling fallback while the stream is disconnected); a cancelled row shows `cancelled` with tracking stopped. A `409` or `401` response SHALL surface the structured error message without changing the row's status.

#### Scenario: Confirmed action updates the row
- **WHEN** the user confirms a cancel on a `queued` row and the API responds `200` with status `cancelled`
- **THEN** the row SHALL show `cancelled` without the user refetching the page

#### Scenario: Conflicting action is surfaced
- **WHEN** the API responds `409` to a recovery action (for example the row left its eligible state before the call landed)
- **THEN** the UI SHALL display the structured error message and refresh that row's status from `GET /events/{id}`

### Requirement: A dead-letter view surfaces terminal failures for recovery
The UI SHALL provide a dedicated dead-letter view listing the organization's terminal `failed` events, fetched from `GET /events` with the `status=failed` filter of the `events-query-api` capability and paginated the same way. Each entry SHALL expose the event identity, attempt count, and lifecycle badge, and SHALL open the event detail (with its failure trail) and invoke the retry action. An empty view SHALL be represented as an explicit nothing-to-recover state.

#### Scenario: Dead-letter view lists failed events with reasons
- **WHEN** the organization has failed events and the user opens the dead-letter view
- **THEN** each failed event SHALL be listed with its identity, attempt count, and a way to inspect its failure trail from `GET /events/{id}`

#### Scenario: Retrying from the dead-letter view removes the entry
- **WHEN** the user retries an event from the dead-letter view and the action succeeds
- **THEN** the event's status becomes `queued`, and the event SHALL no longer appear as terminal-failed the next time the view's failed-only selection is fetched

#### Scenario: Empty dead-letter view is explicit
- **WHEN** the organization has no failed events
- **THEN** the dead-letter view SHALL show an explicit empty state rather than an empty list skeleton or historical rows

#### Scenario: Dead-letter view only shows the caller's organization
- **WHEN** a signed-in organization's user opens the dead-letter view
- **THEN** the listed events SHALL be only that organization's failed events, scoped by the session token

### Requirement: Event details show the result and failure trail
Selecting an event row SHALL open a detail view populated from `GET /events/{id}` that shows: `id`, `status`, `eventType`, `employeeId`, `sequence`, `payload`, `createdAt`, `updatedAt`, `processedAt` (when set), `result` (when present), and the `attempts` array ordered ascending by `attemptNumber`, each attempt exposing `attemptNumber`, `status`, `errorType`, `failedReason`, `result`, and `createdAt` — making temporary vs permanent failure and the exactly-once outcome of processing visible.

#### Scenario: Successful event shows its result
- **WHEN** a `success` event is selected
- **THEN** the detail view SHALL show `processedAt` and the handler `result` stored on the successful attempt

#### Scenario: Failed event shows reason and error type
- **WHEN** a `failed` event is selected
- **THEN** the detail view SHALL show the `failedReason` and `errorType` (`TEMPORARY` or `PERMANENT`) of the failing attempt

#### Scenario: Attempts render in ascending order
- **WHEN** an event has multiple recorded attempts and is selected
- **THEN** the attempts SHALL render in ascending `attemptNumber` order with per-attempt status, result, and `createdAt`

### Requirement: The UI shows the organization's event history with filters
The system SHALL render the event history from `GET /events` alone: on page load and whenever the active filters change, the UI SHALL fetch the current page for the signed-in organization. The UI SHALL provide filters for `status`, `eventType`, and `employeeId`, and SHALL offer a load-more action following `nextCursor`. Submitting an event SHALL make it appear in the history without any client-side persistence. Reloads SHALL show the same data the server holds. Because the list is server-scoped, ending a session SHALL inherently reveal no other organization's events.

#### Scenario: History loads from the server
- **WHEN** a signed-in user opens the events view
- **THEN** the list SHALL be populated by `GET /events` and SHALL contain events the user submitted in previous sessions, without a form submission in this one

#### Scenario: Filters narrow the visible list
- **WHEN** the user applies a status, event-type, or employee filter
- **THEN** the list SHALL re-fetch from `GET /events` with those filters and show only the matching events

#### Scenario: Submitting an event appears in history
- **WHEN** the user submits an event through the form
- **THEN** the event SHALL appear in the history list without a page reload

#### Scenario: Load more appends the next page
- **WHEN** the user activates the load-more action while a `nextCursor` exists
- **THEN** the next page's events SHALL be appended below the current ones

#### Scenario: An empty history is represented, not improvised
- **WHEN** the organization has no events matching the current filters
- **THEN** the UI SHALL show an empty state rather than stale or locally-invented rows

#### Scenario: Session switch leaves no residue
- **WHEN** the user signs out and a different organization signs in
- **THEN** the events view SHALL show only the new organization's history, fetched with the current session's token

### Requirement: The API location is configurable and the app is containerized
The UI SHALL read the API base URL from a `VITE_API_URL` build-time environment variable, defaulting to `http://localhost:3000`, and SHALL use it as the base origin for all HTTP requests. The UI SHALL be a workspace application owning its own Dockerfile, built with the workspace root as its build context, and the repository SHALL ship a `docker-compose.yml` `frontend` service that builds and serves the UI such that `docker compose up --build` serves it at `http://localhost:5173` alongside the API, satisfying the `infrastructure-setup` five-service startup requirement.

#### Scenario: Custom API base URL
- **WHEN** the frontend is built with `VITE_API_URL` set to a non-default origin
- **THEN** all API requests SHALL target that origin

#### Scenario: Docker compose serves the real UI
- **WHEN** a developer runs `docker compose up --build` with the API healthy
- **THEN** `http://localhost:5173` SHALL serve the built demo UI and submissions from it SHALL reach the API

#### Scenario: The UI is built and served as a workspace member
- **WHEN** the UI's image is built
- **THEN** the build SHALL install the UI application's dependencies from the workspace lockfile and produce the same static bundle as a host build of the same application, so the containerised UI and a locally served UI are the same artifact

### Requirement: The UI authenticates against the API and keeps the session usable
The system SHALL present a sign-in step before the event views, offering both sign-in for an existing account and registration of a new organization and owner. On success the UI SHALL retain the returned access token and refresh token so the session survives a page reload. Every subsequent API request SHALL carry the access token. When a request fails with HTTP `401` because the access token expired, the UI SHALL attempt a single refresh using the stored refresh token and retry the request; if the refresh fails, the UI SHALL discard the session, return to the sign-in step, and discard any tenant data held in the browser. Signing out SHALL revoke the refresh token through the API and clear the retained session.

#### Scenario: Sign-in unlocks the event views
- **WHEN** a user submits valid credentials on the sign-in step
- **THEN** the UI SHALL show the event submission and tracking views, and requests SHALL carry the returned access token

#### Scenario: Registration creates an organization and signs in
- **WHEN** a user registers with an email, password, a name, and an organization name
- **THEN** the UI SHALL sign them in with the returned session and show the organization they are acting in

#### Scenario: Session survives a reload
- **WHEN** the page is reloaded while a session is retained
- **THEN** the UI SHALL restore the session and SHALL NOT require the user to sign in again

#### Scenario: Expired access token is refreshed transparently
- **WHEN** an API request fails with HTTP `401` and a usable refresh token is retained
- **THEN** the UI SHALL refresh the session once and retry the request, and the user SHALL NOT be returned to the sign-in step

#### Scenario: Failed refresh clears the session
- **WHEN** a refresh attempt is rejected by the API
- **THEN** the UI SHALL clear the retained session and tracked events, and SHALL show the sign-in step

#### Scenario: Signing out revokes and clears the session
- **WHEN** the user signs out
- **THEN** the UI SHALL call the logout endpoint, clear the retained tokens, and return to the sign-in step

#### Scenario: Tracked events are not shared between sessions
- **WHEN** a session ends and a different account signs in on the same browser
- **THEN** the previously tracked events SHALL NOT be shown, because the UI SHALL only ever display events fetched with the current session's token

### Requirement: The UI manages the organization's employee directory

The system SHALL provide an Employees view, reachable from the workspace view switch alongside
the event views, that renders the directory from `GET /employees` alone: on open and after any
change it SHALL fetch the current page (employee number, name, department, active flag, created
time) for the signed-in organization, with an `active` filter and a load-more action following
`nextCursor`. The view SHALL let the user register an employee (`employeeNumber`, `name`,
optional `department`), correct `name` / `department` / `active` on an existing employee, and
archive one with confirmation; surfacing the structured error message on `400`/`409` without
losing entered values. An archived employee SHALL be shown as archived in the list and SHALL no
longer be offered by the submission form's employee field. Directory data SHALL only be fetched
and mutated with the session token; reloads SHALL show the same data the server holds, and a
different organization signing in SHALL see only its own directory.

#### Scenario: Registering an employee appears immediately
- **WHEN** the user submits the create form with valid values
- **THEN** the new employee SHALL appear in the list (and in the submission form's picker) fetched from the server, without a page reload

#### Scenario: A duplicate employee number is surfaced
- **WHEN** the user registers an `employeeNumber` that already exists in the organization
- **THEN** the UI SHALL show the structured `409` error and keep the form values editable

#### Scenario: Editing and archiving update the row in place
- **WHEN** the user corrects an employee's department or archives them (confirming when prompted)
- **THEN** the row SHALL reflect the change fetched from the server, and an archived employee SHALL be marked inactive

#### Scenario: Archiving removes the employee from the submit picker
- **WHEN** an employee the user previously used in the submission form is archived
- **THEN** the submission form SHALL no longer offer that employee for new submissions

#### Scenario: Empty and filtered directory are represented, not improvised
- **WHEN** the organization has no employees matching the current `active` filter
- **THEN** the view SHALL show an empty state rather than stale or locally-invented rows

#### Scenario: A session switch leaves no directory residue
- **WHEN** the user signs out and a different organization signs in
- **THEN** the Employees view SHALL show only the new organization's directory, fetched with the current session's token

### Requirement: Tracked-list statuses update live over the event stream

While an event view is open, the UI SHALL subscribe once to `GET /events/stream` of the `event-status-stream` capability, authenticating with the session's access token, and SHALL update each rendered row's status badge in place as its notification arrives.

#### Scenario: A transition is reflected without interval polling
- **WHEN** an event rendered in the open list reaches `success` while the stream is connected
- **THEN** the row's badge SHALL become `success` driven by the stream notification, with no fixed-interval `GET /events/{id}` request issued for it

#### Scenario: A terminal row hydrates its attempt count once
- **WHEN** a row's terminal notification (`success`, `failed`, or `cancelled`) arrives
- **THEN** the UI SHALL perform at most one `GET /events/{id}` for that row to record the attempt count, and SHALL issue no further tracking requests for it while the stream stays healthy

#### Scenario: Retry backoff keeps the last committed badge
- **WHEN** the worker is between BullMQ retry attempts for an event (the claim rolled back and nothing new committed)
- **THEN** the row SHALL keep showing the last announced committed state (`queued`) until a terminal notification arrives, consistent with the `event-status-api` contract

#### Scenario: A notification for an unlisted event adds no row
- **WHEN** a notification names an event that is not in the rendered list (for example it is filtered out or lives on a later page)
- **THEN** the UI SHALL ignore it and the list SHALL NOT grow a phantom row

### Requirement: Stream loss degrades to the polling fallback

While the stream is healthy the UI SHALL NOT poll `GET /events/{id}` on a fixed interval. When it is disconnected or failing, the UI SHALL poll non-terminal rows at a fixed interval (default 3 seconds) with the former per-row semantics: a failing poll marks only its own row unavailable; a retried row re-enters tracking until a terminal state. On reconnect the UI SHALL re-synchronize visible rows from the read endpoints (the stream replays nothing) and resume in-place updates.

#### Scenario: A failed poll does not break the list
- **WHEN** the stream is down and a single `GET /events/{id}` poll fails (network error or HTTP `404`)
- **THEN** the UI SHALL mark that row as unavailable/errored and continue rendering and polling the other rows

#### Scenario: Reconnect resumes live updates from a synchronized state
- **WHEN** the stream reconnects after a disconnection during which transitions may have been missed
- **THEN** the UI SHALL refresh the visible rows' statuses from the read endpoints and SHALL NOT rely on replayed notifications for the gap

#### Scenario: The fallback tracks a retried row to terminal
- **WHEN** the user retries a `failed` row while the stream is disconnected and the action succeeds
- **THEN** the row's badge SHALL show `queued` again and the fallback polling SHALL track it until a terminal state is observed

### Requirement: The UI manages the organization's members and accepts invitations

The web app SHALL offer a members view listing the organization's members (identity, email,
role, joined at) for every signed-in member, and SHALL surface invite, role-change, and remove
actions only when the signed-in role satisfies the API's requirements (role from the stored
session), sending the same structured 403 handling as other gated features. The app SHALL offer
an invitation-acceptance state reached by opening the accept URL: it SHALL collect the initial
password when the invited email has no account (explaining what will be created), collect the
account password for existing accounts, display the returned organization identity after
success, and hand the user to sign-in for that organization. The acceptance route SHALL take the
token from the URL and never expose it in editable fields.

#### Scenario: Signed-in member browses the member list
- **WHEN** any member opens the members view
- **THEN** the members of their organization SHALL be listed with their roles, and no other organization's members SHALL appear

#### Scenario: Management actions are role-gated in the UI
- **WHEN** a signed-in MEMBER opens the members view
- **THEN** invite, role-change, and remove controls SHALL NOT be presented; when a MEMBER somehow invokes them anyway, the API's 403 SHALL surface through the existing error display

#### Scenario: Admin invites from the UI
- **WHEN** a signed-in ADMIN submits the invite form with an email and role
- **THEN** the UI SHALL display the returned accept URL for out-of-band hand-off and include the invitation in the visible list

#### Scenario: Invitee completes acceptance from the link
- **WHEN** the invitee opens the accept URL in the web app and submits the form
- **THEN** the account/membership SHALL be created through the API and the UI SHALL show the organization joined and route to sign-in

#### Scenario: Owner changes a role from the UI
- **WHEN** the OWNER changes a member's role in the members view
- **THEN** the list SHALL reflect the change after the API confirms it
