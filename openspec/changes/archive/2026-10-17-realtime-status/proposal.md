# Proposal: realtime-status

## Why

The UI observes lifecycle changes by polling: every non-terminal row fires `GET /events/{id}` on a fixed 3-second cadence (`useEventHistory`), so a badge lags the real transition by up to a full interval, and an active list produces a constant stream of per-row requests even when nothing changes. Server-Sent Events replace that fan-out with one long-lived connection per session: transitions are pushed to every connected client within milliseconds, request volume collapses, and the demo UI visibly tracks the lifecycle in near-real time — the behaviour the reliability story already promises elsewhwhere is now observable live.

## What Changes

- **New SSE endpoint `GET /events/stream`** — an authenticated, tenant-scoped `text/event-stream` that pushes one notification per committed lifecycle transition (`received → queued → processing → success | failed`, plus `cancelled` and manual retries) for the caller's organization. Heartbeats keep idle connections alive; the connection is closed cleanly on sign-out/shutdown.
- **Lifecycle transition publication** — every current transition site publishes a notification after its transaction commits: in the API process (submission queueing, retry, cancel) and in the worker process (claim, terminal success/failure writes, retry exhaustion). Fan-out between the two processes rides Redis pub/sub on the existing Redis instance, colocated with BullMQ's usage of it.
- **Frontend switches to stream-driven status** — the per-row 3-second polling is replaced by an SSE subscription: rows update in place as notifications arrive, the detail panel re-reads `GET /events/{id}` when its event transitions, and one detail fetch hydrates the attempt trail when a row reaches a terminal state. If the stream is down, the UI degrades to the previous polling behaviour until it reconnects, so status never goes stale silently.
- **No API contract change** — `GET /events`, `GET /events/{id}`, and the recovery endpoints are untouched; the stream is additive. A stream notification is a *hint*, not data: the database row remains the only source of truth, exactly as with the queue today.

## Capabilities

### New Capabilities

- `event-status-stream`: the server-pushed lifecycle notification stream — endpoint behaviour, authentication and tenant isolation of deliveries, notification payload, heartbeats, deliverability guarantees (best-effort, post-commit, no consumer-visible ordering requirement beyond a single event's transitions), and clean termination.

### Modified Capabilities

- `frontend-app`: the live-polling requirement ("The tracked list live-polls event statuses") becomes stream-driven status updates with the poller demoted to a connection-loss fallback; related scenarios (retry re-enters tracking, terminal states stop updates, a missed update self-heals) are restated against the stream.

## Non-goals

- **Guaranteed delivery / transactional outbox** — the stream is best-effort UI acceleration; correctness never depends on it. The transactional outbox is the `integrator-webhooks` change's mechanism and stays there.
- **`Last-Event-ID` replay** — a reconnecting client resynchronizes by re-fetching the list/detail (the existing fallback poller covers any gap), not by server-side event replay.
- **WebSockets or connection multiplexing** — one unidirectional SSE connection per browser session; no per-user subscriptions beyond the organization boundary.
- **Query-string tokens** — the endpoint keeps header authentication; the browser client consumes the stream via `fetch` + `ReadableStream` (which can send the `Authorization` header), not `EventSource`.

## Impact

- **`packages/core`** — new stream module (SSE controller + subscription service, `events/`); new lifecycle publisher invoked from `EventsService`, `EventRecoveryService`, `EventClaim`, and `PayrollEventProcessor` (always strictly *after* the committing transaction, never inside one); module wiring in both composition roots.
- **`packages/shared`** — stream event-type constants and payload types shared by publisher and consumers.
- **`@repo/database`** — a small pub/sub connection factory (dedicated ioredis clients, separate from BullMQ's blocking connections) configured from the same `REDIS_HOST`/`REDIS_PORT`.
- **`apps/web`** — `useEventHistory` loses the polling interval to a `useEventStream` hook; `api/` gains a stream consumer with the existing authenticated client's refresh/retry semantics.
- **Tests** — unit tests for publisher/subscription; e2e suites for the stream endpoint (401, tenant isolation, notification delivery on real transitions, heartbeat, Redis-down behaviour); frontend Vitest for the stream hook including reconnect/fallback paths.
- **CI/docs** — Swagger annotations for the new endpoint; README/architecture note on the realtime path.
