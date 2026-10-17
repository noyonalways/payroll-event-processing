# Design: realtime-status

## Context

Two Nest processes share `@repo/core` as the composition-root package: the API (`apps/api`, boots `AppModule`) and the BullMQ worker (`apps/worker`, boots `WorkerModule`). A lifecycle transition commits in either process:

- API process — `EventsService.markQueued` (`received → queued` after submission, `packages/core/src/events/events.service.ts`), `EventRecoveryService.retryEvent` / `cancelEvent` (`packages/core/src/events/event-recovery.service.ts`).
- Worker process — the single claim transaction in `EventClaim.claimAndProcess` (`packages/core/src/processing/event-claim.ts`) commits `queued → processing → success | failed` atomically; `PayrollEventProcessor.onFailed` (`packages/core/src/worker/payroll-event.processor.ts`) commits the exhaustion `queued → failed`; the processor's pre-claim make-safe flips `received → queued`.

Because worker transitions happen in a different OS process than the HTTP layer, in-process event emitters cannot reach connected clients — the fan-out needs a cross-process transport. Redis is already the shared infrastructure of both processes (BullMQ, configured from `REDIS_HOST`/`REDIS_PORT` via `QueueModule`). On the client, the UI polls today in `apps/web/src/lib/useEventHistory.ts` (3 s interval over `GET /events/{id}`) through the authorized `fetch` client in `apps/web/src/api/client.ts`.

There are **no DB schema changes** in this design — no new tables, columns, indexes, or constraints. The committed `payroll_events.status` row remains the sole source of truth; the stream is derived from existing commit points (deliberately no outbox table — see Non-goals).

## Goals / Non-Goals

**Goals:**

- One cross-process publication path for every committed lifecycle transition, colocated with the existing Redis usage.
- An authenticated, tenant-scoped SSE endpoint consumed by the browser UI, replacing fixed-cadence status polling.
- Fail-soft end to end: publishing never blocks, fails, or delays a transition (R1/R2-style isolation of the critical path); UI falls back to polling on stream loss.

**Non-Goals:**

- Delivery guarantees, transactional outbox, or replay — that mechanism belongs to `integrator-webhooks`.
- Any change to the REST contracts (`GET /events`, `GET /events/{id}`, recovery endpoints).
- Persisting subscriber state; scaling concerns beyond "one shared subscriber connection per API process".

## Decisions

### D1 — Cross-process fan-out: Redis pub/sub over dedicated connections

Publisher and subscriber are two dedicated `ioredis` connections created in **`packages/database/src/pubsub/`** (`pubsub.module.ts`, `pubsub.service.ts`, exported from `packages/database/src/index.ts` as `PubSubModule`), configured from the same `REDIS_HOST`/`REDIS_PORT` env the `QueueModule` reads.

- Why dedicated connections: BullMQ requires exclusive connections, and an ioredis connection in subscriber mode cannot issue regular commands — the publisher (used by both processes) and the subscriber (API only) must each own a clean connection.
- Channel: a single topic `payroll-event-status` (constant `EVENT_STATUS_STREAM_CHANNEL` in **`packages/shared/src/stream.constants.ts`**) carrying messages that include `organizationId`. The API process runs ONE shared subscriber and fans messages out in-process to the per-connection client registries (a `Map<organizationId, Set<Client>>`).
- Why one channel + in-process filtering over per-org channels: message volume is trivial, it keeps publisher logic channel-agnostic, and the tenant filter is applied twice — once by the subscriber's dispatch registry, and once defensively per client before write (a payload naming an organization a client does not belong to is dropped, never relayed). Together with D3's tenant-qualified payloads this keeps R6/tenancy (deny-by-default, cross-org reads are unobservable) intact on the new surface.

### D2 — Notification payload and publisher service

`packages/shared/src/stream.types.ts` defines the wire type (consumed by both processes and the frontend):

```ts
interface EventStatusNotification {
  organizationId: string;
  eventId: string;        // payroll_events.id
  eventType: EventType;
  employeeId: string;
  sequence: number;       // Number(bigint), same coercion convention as the DTOs
  status: LifecycleStatus; // the NEWLY COMMITTED status
  occurredAt: string;      // ISO-8601
}
```

`packages/core/src/events/event-status.publisher.ts` provides `EventStatusPublisher.publish(notification): Promise<void>` — a single `redis.publish` that catches and logs everything.Publication failures are swallowed with structured logs (same posture as the enqueue path's best-effort catch: this is the R2 isolation discipline applied to the stream — the publish path can never corrupt the exactly-once processing write (R5) or delay a request). Ordering: Redis delivers per-publisher messages in FIFO order, so one event's transitions arrive in commit order on a subscriber; the spec deliberately promises no cross-event ordering (parallel employees, R6, are unrelated).

### D3 — Publish points: strictly post-commit, outcome-driven

Publication sites sit immediately **after** the committing operation returns, never inside a Prisma transaction (a publish inside `claimAndProcess`'s `$transaction` would couple the exactly-once terminal write (R5) to Redis availability, and a rollback would have already retracted the row state):

- `EventsService.markQueued` — publish `queued` when the guarded `received → queued` transition applied (`updateMany` count > 0). When the count is 0 the announcement belongs to whichever path actually moved the row (the worker's make-safe backstop below), so nothing is published; this announcement doubles as the "event exists" notification.
- `EventRecoveryService.retryEvent` — `queued`, after its transaction commits; `cancelEvent` — `cancelled`, likewise.
- `PayrollEventProcessor.process()` — after `EventClaim.claimAndProcess` resolves: outcome `success` → publish `success`; outcome `permanent-failure` → publish `failed`; outcome `skipped` → nothing (the already-committed outcome was published by its own path). Separately, the pre-claim make-safe publishes `queued` when its guarded `received → queued` write applied — the backstop announcement for the best-effort case where the API-side `markQueued` write failed; the submitting client adds the row from the 201 body as it does today, so no new submission flow is needed.
- `PayrollEventProcessor.onFailed` — after the exhaustion transaction (`queued → failed`) commits → publish `failed`.
- No publication for a transiently failed attempt: its transaction aborted, the committed status is still `queued`, and the row's attempt row is bookkeeping — announcing `processing` would violate the committed-state rule and the event-status-api's polling contract.

### D4 — SSE endpoint: Nest `@Sse()` in the Events module

`packages/core/src/events/event-stream.controller.ts` exposes `GET /events/stream` via Nest's `@Sse()` decorator; `event-stream.service.ts` owns the in-process registry and per-connection observables. Registered in `EventsModule` (`packages/core/src/events/events.module.ts`) — which only `AppModule` imports, so the endpoint exists in the API process only, exactly like `EventsController`.

- **Auth**: no `@Public()` anywhere on the controller, so the global `JwtAuthGuard` covers it — same header authentication as every other event route; a stream can never outlive its issuing identity's organizations. R6/tenancy: the organization comes from the verified token, the subscriber joins only its org's registry.
- **Payload per client**: on subscription the service merges a periodic heartbeat (`interval`) with the org-filtered notification stream, emitting SSE `data:` frames of JSON notifications. Heartbeats are SSE **comment** lines (`: heartbeat`), which every conforming consumer ignores but which keep the TCP path warm — interval configurable via a new `EVENT_STREAM_HEARTBEAT_INTERVAL_MS` env (Joi default `15000` in `packages/core/src/app.module.ts`).
- **Teardown**: the connection observable's `finalize` removes the client from the registry; `onModuleDestroy` (plus `app.enableShutdownHooks()` added to `apps/api/src/main.ts`) closes every open stream with a terminal SSE event on shutdown. Today the API process registers no shutdown hooks — this is the smallest change that makes stream termination observable.
- **Swagger**: `@ApiOperation`/`@ApiOkResponse` annotated as an `text/event-stream` response (OpenAPI cannot fully express streaming; the annotation documents reachability, auth, and the frame shape). The `api-documentation` spec's UI/JSON endpoints are untouched.

### D5 — Browser consumption: fetch-based stream + polling fallback

`apps/web/src/api/stream.ts` opens `GET /events/stream` with `fetch` + the existing `authorizedInit` transport (exported from `client.ts` as `fetchAuthorized`, which keeps the single 401 → refresh-token rotation → replay semantics of `request()` but returns the raw `Response` instead of parsing JSON — `EventSource` is unusable here because it cannot send the `Authorization` header and query-string tokens are rejected by the proposal). The reader consumes `res.body` incrementally, buffering partial chunks and splitting frames on blank lines; comment lines are liveness only; malformed/unknown payloads are dropped defensively.

`apps/web/src/lib/useEventStream.ts` owns subscription lifecycle while an event view is mounted:

- notification → update the matching row's status badge in place (no phantom rows for unlisted ids); terminal notification → one `fetchEventStatus` hydration for the attempt count, then the row is untracked.
- selected-detail wiring: when the selected event's notification arrives, `EventDetail` re-reads `GET /events/{id}`.
- disconnect/error → the hook reports `streamConnected: false`; `useEventHistory` resumes its existing interval-polling block verbatim (the current 3 s cadence, per-row error isolation — the fallback is the *old* behavior, kept rather than deleted);
- reconnect (with backoff, after a 401-refresh rotation) → one `refresh()` page-one re-fetch re-synchronizes any missed transitions, then in-place updates resume.

### D6 — Tests

- Unit: publisher (swallow + log on Redis error), stream service (org-disjoint fan-out, defensive drop of foreign/undecodable payloads, heartbeat tick, teardown), processor publishes on outcomes (extend `payroll-event.processor.spec.ts`), frontend stream parser + hook fallback matrix (Vitest — `useEventHistory.test.ts` gains fallback assertions; new `stream.test.ts`/`useEventStream.test.tsx`).
- e2e `apps/api/test/event-stream.e2e-spec.ts` with real Postgres + Redis: 401 without token; submission → observed `queued`/`success` frames on a live stream (raw `http` client + `AbortController` with hard timeouts so an infinite stream cannot hang the suite); cancel → `cancelled` frame; two organizations hold disjoint streams; recovery endpoints announce their transitions.
- e2e reliability regression: the existing suites (`event-queue`, `processing`, `tenant-isolation`, …) must pass unchanged — they guard the invariants the publish hooks must not disturb (no publish call is allowed to throw into a committing operation).

## Risks / Trade-offs

- [Notification lost between commit and publish (process crash in the window)] → Accepted by spec: best-effort, resynchronized on reconnect via `refresh()` and the polling fallback; the DB row is authoritative.
- [Redis unavailability breaks the stream] → Streams fail to open / die client-side; the UI polls (old behavior) — status visibility degrades to today's baseline; publishing is fire-and-forget so submissions and worker outcomes are unaffected (the `event-queue-redis-down` posture, extended to the stream).
- [Slow/broken SSE client stalls a registry write] → Each client write is guarded; any write failure tears down only that client's connection, never the process or other subscribers.
- [Nginx/proxy buffering or idle-timeout kills the stream] → The frontend talks to the API directly over CORS (no proxying in compose), and the 15 s heartbeat defeats idle timeouts; checked in the docker-compose e2e path.
- [e2e flakiness from infinite streams] → All stream reads run under `AbortController` with explicit first-frame timeouts; the suite treats "no frame within N" as a failure signal rather than waiting forever.
- [`@Sse()` + Nest 11/Express 5 edge cases (compression, flush) observed in practice] → No compression middleware is registered; if `@Sse()` proves awkward (e.g. requires response flushing not exposed by the decorator), the fallback implementation is a raw `@Res()` write loop with the same service behind it — a controller-local swap with no contract change.

## Migration Plan

Additive rollout: publish hooks + endpoint + module wiring land together (worker and API deploy as one compose project, so the channel contract never has a half-populated window); the frontend ships its fallback first-in-time (polling exists today), so any partial state degrades to current behavior. Rollback is a revert — no schema, no stored data, no REST contract change.

## Open Questions

None material. (`@Sse()` vs raw-res is settled by D4's named fallback; heartbeat default 15 s is a config knob, not an open question.)
