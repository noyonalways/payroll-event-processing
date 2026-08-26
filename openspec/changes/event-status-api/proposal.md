# Proposal — event-status-api

## Why

The service accepts payroll events (`POST /events`) and reports its own health (`GET /health`), but offers **no way to query an individual event's current lifecycle state, result, or processing history**. Once an event is accepted, the asynchronous worker advances it `received → queued → processing → success | failed` out of band from the HTTP response — so consumers and operators have no API to answer "what happened to my event?" Auditing a dispute, debugging a failed change, or writing a client that polls an event to completion all require visibility that only exists today inside the database.

## What Changes

- Add `GET /events/:id` returning the event's **current status** and full lifecycle detail: `id`, `eventType`, `employeeId`, `sequence`, `status`, `createdAt`, `updatedAt`, `processedAt`, and `result` (when the event succeeded).
- Include the **attempt history** from the append-only `event_attempts` audit trail: one entry per terminal attempt with `attemptNumber`, `status`, `errorType`, `failedReason`, `result`, and `createdAt`.
- Return HTTP **404** with the existing structured `ErrorResponseDto` when no event matches the id; the endpoint is read-only and never mutates state.
- Document the new operation and its typed response (`EventStatusResponseDto` + `EventAttemptDto`) in Swagger/OpenAPI alongside the existing submission contract.

**BREAKING:** none — purely additive. New endpoint, new 404 response type on the `events` tag; no existing behavior changes.

## Capabilities

### New Capabilities
- `event-status-api`: querying a payroll event's lifecycle state and terminal-attempt history by its id (read-only `GET /events/:id`, 404 for unknown ids).

### Modified Capabilities
- `api-documentation`: the documented API surface grows from `POST /events` + `GET /health` to also include `GET /events/:id`; the OpenAPI component set gains `EventStatusResponseDto` and `EventAttemptDto`.

## Impact

- **Code**: `src/events/` gains a read path — a `getEventStatus(id)` method on `EventsService` (or a sibling status service) plus a `GET /events/:id` handler on `EventsController`; new DTOs (`EventStatusResponseDto`, `EventAttemptDto`) with Swagger annotations; no schema, queue, or worker changes.
- **Database**: read-only use of `payroll_events` and `event_attempts`; no migration. Nesting the attempt query uses the existing `@@index([eventId])` on `event_attempts`.
- **Tests**: unit coverage for the controller/service read path and 404 handling; e2e coverage for a real event going through to `success`/`failed` and being retrievable with its attempts.
- **Docs**: `docs/architecture.md` and the roadmap note the new read endpoint.

## Non-goals

- No list/query-by-employee endpoint (ordering, pagination, and filtering are future work).
- No mutation through this API — no cancel, no retry, no re-enqueue.
- No authentication/authorization (consistent with the rest of the service).
- No change to `POST /events`, the queue, or the worker lifecycle.