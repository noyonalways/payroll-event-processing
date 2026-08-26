# Tasks — event-status-api

## 1. Response DTOs

- [x] 1.1 Create `src/events/dto/event-attempt.dto.ts` exporting `EventAttemptDto` (D5): `attemptNumber` (int), `status` (`SUCCESS`|`FAILED`), `errorType` (`TEMPORARY`|`PERMANENT`|null), `failedReason` (string|null), `result` (object|null), `createdAt` (string ISO) — each with `@ApiProperty` description/example
- [x] 1.2 Create `src/events/dto/event-status-response.dto.ts` exporting `EventStatusResponseDto` (D5): `id`, `eventType`, `employeeId`, `sequence` (number — NOT BigInt), `status` (enum of all five `EventStatus` values), `payload` (object), `createdAt`, `updatedAt`, `processedAt` (string|null), `result` (object|null), and `attempts: EventAttemptDto[]` — with `@ApiProperty` annotations and an `@ApiProperty({ type: [EventAttemptDto] })` for the array

## 2. Service read path (reliability-critical: R5 exactly-once consistency of status + attempt trail)

- [x] 2.1 Implement `getEventStatus(id: string)` in `src/events/events.service.ts` (design D2/D4): `payrollEvent.findUnique({ where: { id } })` → throw `NotFoundException('Event with id ... not found')` when null; then `eventAttempt.findMany({ where: { eventId: id }, orderBy: { attemptNumber: 'asc' } })`; map to `EventStatusResponseDto` with `sequence: Number(row.sequence)` and `attempts` field names aligned (camelCase). No DB mutation anywhere in the path
- [x] 2.2 Extend `src/events/events.service.spec.ts` alongside 2.1: 404/missing → `NotFoundException` (or a rejected `getEventStatus`); full field mapping incl. `BigInt`→number; null passthrough for `processedAt`/`result`; attempts ordered ascending by `attemptNumber`; JSON round-trip (`JSON.stringify` does not throw on the mapped object)

## 3. Controller route

- [x] 3.1 Add `@Get(':id')` to `src/events/events.controller.ts` (design D1/D3): `@ApiTags('events')` (existing), `@ApiOperation` summary/description, `@ApiParam({ name: 'id', ... })`, `@ApiOkResponse({ type: EventStatusResponseDto })`, `@ApiNotFoundResponse({ type: ErrorResponseDto })`; handler calls `getEventStatus(params.id)` and returns the DTO (Nest serializes primitives + JSON automatically)
- [x] 3.2 Extend `src/events/events.controller.spec.ts` alongside 3.1: route returns 200 with the service result; service rejection propagates (404 body shape delegated to the global filter — assert the controller does not swallow it)

## 4. e2e verification

- [x] 4.1 Write/extend an e2e spec (`test/event-status.e2e-spec.ts`) against the Dockerized stack asserting the event-status-api delta scenarios: (a) submit → `GET /events/:id` returns `status: queued` with `attempts: []` (before processing completes); (b) an event that reaches `success` returns 200 with non-null `processedAt`, `result`, and a `SUCCESS` attempt whose `result` matches the event row's and `attemptNumber` matches; (c) an event that exhausts retries returns `status: failed` with a `FAILED` attempt carrying `errorType` + `failedReason`; (d) unknown id → HTTP 404 with the `ErrorResponseDto` shape; (e) attempts ordered ascending by `attemptNumber` for a multi-attempt event (reuse the transient-failure cadence harness from `test/processing.e2e-spec.ts` if needed)
- [x] 4.2 Assert `/api-docs-json` in an existing health/api-docs e2e (or 4.1): `paths` contains `/events/{id}` and `components.schemas` contains `EventStatusResponseDto` + `EventAttemptDto` (api-documentation delta)

## 5. Docs & pipeline

- [x] 5.1 Update `docs/architecture.md` (API surface gains `GET /events/:id`; note the read-only status + attempt-trail semantics) and add/mark the roadmap row for the event-status read endpoint
- [x] 5.2 Green pipeline: `npm run lint:check`, `npm test`, and `npm run test:e2e` (Dockerized Postgres/Redis) all pass

## 6. Cleanup

- [x] 6.1 Grep for stale doc/comment references to "no read endpoint for events" / "status only via POST response" and update
- [ ] 6.2 Conventional commit(s) for the change when implementation is green (left to the user per the no-commit directive)