# Tasks

## 1. Shared vocabulary and Redis pub/sub connections

- [x] 1.1 Add `EVENT_STATUS_STREAM_CHANNEL` to `packages/shared/src/stream.constants.ts` and the `EventStatusNotification` wire type to `packages/shared/src/stream.types.ts` (fields per design D2, reusing the shared `LifecycleStatus`/`EventType`), exporting both from `packages/shared/src/index.ts` — verify by building `@repo/shared` (`pnpm turbo run build --filter=@repo/shared`)
- [x] 1.2 Add `PubSubModule` in `packages/database/src/pubsub/pubsub.service.ts` / `pubsub.module.ts` (two dedicated ioredis connections from `REDIS_HOST`/`REDIS_PORT`: one regular publisher, one subscriber-mode; no BullMQ connection sharing) and export it from `packages/database/src/index.ts` — write the round-trip unit test alongside (publish → subscriber receives the same message against the docker Redis) and verify it passes

## 2. Publisher and publish hooks

- [x] 2.1 Create `EventStatusPublisher` in `packages/core/src/events/event-status.publisher.ts` plus an exporting `EventStatusPublisherModule` (`packages/core/src/events/event-status-publisher.module.ts`, importing `PubSubModule` so both `EventsModule` and the worker can inject it) — publish is fire-and-forget that catches, logs (eventId/eventType/employeeId/organizationId), and never rethrows **[reliability-critical: the R2 isolation discipline — a stream failure may never reach a committing operation or fail an HTTP response]** — write unit tests alongside (payload serialized as the channel message; Redis error swallowed + logged) and verify they pass
- [x] 2.2 **[reliability-critical: publishes strictly after the committing transaction, never inside one — R5]** Wire the API-process hooks: `EventsService.markQueued` publishes `queued` only when its guarded transition applied (count > 0), `EventRecoveryService.retryEvent` publishes `queued` and `cancelEvent` publishes `cancelled` after their transactions commit — modify `packages/core/src/events/events.service.ts` and `packages/core/src/events/event-recovery.service.ts` with unit tests in their existing spec files (markQueued failure → no publish and the 201 is unaffected; commit rollback → no publish) and verify they pass
- [x] 2.3 **[reliability-critical: outcome-driven post-commit publish; a transiently aborted claim publishes nothing]** Wire the worker-process hooks in `packages/core/src/worker/payroll-event.processor.ts`: pre-claim make-safe publishes `queued` when it applied, `claimAndProcess` outcome `success`/`permanent-failure` publishes accordingly, `skipped` publishes nothing, `onFailed`'s exhaustion transaction publishes `failed` — extend `packages/core/src/worker/payroll-event.processor.spec.ts` alongside (including the transient-abort and stale-job no-publish cases) and verify the suite passes

## 3. SSE endpoint

- [x] 3.1 Create `packages/core/src/events/event-stream.service.ts`: the in-process registry (`Map<organizationId, Set<client>>`) fed by the shared Redis subscriber, org-filtered dispatch with a defensive second filter that drops payloads naming another organization or failing to decode, per-client heartbeat comment at `EVENT_STREAM_HEARTBEAT_INTERVAL_MS`, teardown on client disconnect, and `onModuleDestroy` closing every open stream — unit tests alongside (disjoint fan-out for two organizations; foreign/undecodable payload dropped; heartbeat tick; teardown removes the client) and verify they pass
- [x] 3.2 Create `packages/core/src/events/event-stream.controller.ts` exposing `GET /events/stream` via Nest `@Sse()` (no `@Public()`, so the global JWT guard applies; Swagger `@ApiOperation`/`@ApiOkResponse` documenting the `text/event-stream` frames) and register it in `packages/core/src/events/events.module.ts` — controller unit test for the observable merger and verify it passes
- [x] 3.3 Add `EVENT_STREAM_HEARTBEAT_INTERVAL_MS` (default 15000) to the Joi env schema in `packages/core/src/app.module.ts` and call `app.enableShutdownHooks()` in `apps/api/src/main.ts` — verify the API boots with the variable set and absent

## 4. Stream e2e (real Postgres + Redis, `apps/api/test/event-stream.e2e-spec.ts`)

- [x] 4.1 Auth and transport: a tokenless request is 401; a request with a valid access token establishes a `text/event-stream` response and stays open — consume with a raw `http` client + `AbortController` and hard frame timeouts (never supertest response parsing of an infinite stream)
- [x] 4.2 Tenant isolation: while organization A holds an open stream, transitions in organization B (second registered org) produce no frames on A's stream — and vice versa
- [x] 4.3 Delivery: submission publishes an observed `queued` frame and, with `PAYROLL_FAILURE_MODE=always-success`, a `success` frame; `POST /events/{id}/cancel` publishes `cancelled`; `POST /events/{id}/retry` publishes `queued`; a heartbeat frame arrives within the configured interval
- [x] 4.4 Regression: the existing e2e suites (`event-queue`, `event-queue-redis-down`, `processing`, `event-status`, `tenant-isolation`, `idempotency-records`, `events-list`) all pass with the publish hooks in place

## 5. Frontend stream consumption

- [x] 5.1 Add `fetchAuthorized` to `apps/web/src/api/client.ts` (keeps the single 401 → refresh rotation → replay, returns the raw `Response`) and create `apps/web/src/api/stream.ts`: open the stream with the `Authorization` header, incrementally parse SSE frames from `res.body` (buffer partial chunks, CRLF, ignore comment liveness lines, drop malformed/unknown payloads), report clean end and disconnect — Vitest alongside in `stream.test.ts` (frames split across chunks; comments ignored; malformed dropped) and a `client.test.ts` case for the refresh-on-401 path; verify they pass
- [x] 5.2 Create `apps/web/src/lib/useEventStream.ts`: one subscription while an event view is open; badge-in-place row updates; a single `GET /events/{id}` hydration on a terminal notification then untrack; notifications for unlisted events ignored; the selected event's detail re-read on its notification; disconnect → `streamConnected: false`; reconnect with backoff → one `refresh()` re-synchronization — Vitest alongside covering the notification matrix and the disconnect/reconnect transitions; verify they pass
- [x] 5.3 Rewire `apps/web/src/lib/useEventHistory.ts` to consume the stream: keep the existing 3-second polling block as a fallback gated on `streamConnected === false` (no interval polling while healthy), honoring the dead-letter pinned-status view — update `useEventHistory.test.ts` and the affected `EventList`/`EventDetail`/`App` component tests, and verify `pnpm vitest` is green in `apps/web`

## 6. Integration verification and documentation

- [x] 6.1 Run the full backend gate (`lint`, unit, e2e via the CI invocation in `.github/workflows`) and the frontend gate (`lint`, `vitest`, `build`) — all green
- [x] 6.2 Verify Swagger: `GET /events/stream` appears in the `/api-docs-json` document with bearer auth (extend the `api-docs` e2e assertion)
- [x] 6.3 Document the realtime path: stream endpoint, publish points, fallback behavior, and the `EVENT_STREAM_HEARTBEAT_INTERVAL_MS` knob in `docs/architecture.md` and the README — verify the documented commands/env names match the code

## Workflow follow-up

- Mark the `realtime-status` row ✅ Done in `openspec_roadmap.md` (Feature Queue item 5) after review.
- Archive the change once the project's review requirements are satisfied (`/opsx:archive`) — the deltas then create the `event-status-stream` main spec and fold the `frontend-app` modifications in.
