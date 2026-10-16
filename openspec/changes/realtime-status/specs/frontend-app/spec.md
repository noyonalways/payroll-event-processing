# Spec Delta

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: The tracked list live-polls event statuses
**Reason**: Status tracking moves from fixed-interval per-row polling to the pushed server-sent events of the new `event-status-stream` capability. Fixed-cadence polling survives only as the documented fallback for stream loss, restated under the new requirement below.
**Migration**: See the ADDED requirement "Tracked-list statuses update live over the event stream".

## ADDED Requirements

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
