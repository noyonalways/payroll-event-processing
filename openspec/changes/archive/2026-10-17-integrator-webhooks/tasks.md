# Tasks

## 1. Schema and outbox writer

- [x] 1.1 Add `webhook_endpoints`, `webhook_deliveries`, `webhook_delivery_attempts` models + enums to `packages/database/prisma/schema.prisma` per design D2, generate the Prisma client, and create the migration — verify `pnpm prisma migrate dev` applies cleanly and client types compile.
- [x] 1.2 Implement `packages/core/src/webhooks/webhook-outbox.writer.ts` (transaction-client-based, bulk-insert per active endpoint, pre-rendered payload snapshot per design D3), wire it into a new `webhooks.module.ts`, and unit-test it with the existing Prisma-mock convention — verify pending rows are written inside the caller's tx and no rows when the org has no active endpoint. **Reliability-critical: this write joins the terminal-commit transaction.**
- [x] 1.3 Call the writer from both terminal-commit sites: the success and permanent-failure paths in `packages/core/src/processing/event-claim.ts` and the cancel path in `packages/core/src/events/event-recovery.service.ts` (design D3) — update `event-claim.spec.ts` and `event-recovery.service.spec.ts` — verify a terminal commit produces exactly one delivery row per active endpoint, and that a thrown writer error rolls the terminal state back (atomicity). **Reliability-critical path.**

## 2. Endpoint configuration API

- [x] 2.1 Add the `webhooks/` NestJS module (controller, service, DTOs with class-validator) exposing `POST /webhook-endpoints` (returns secret once), `GET /webhook-endpoints`, `PATCH /webhook-endpoints/:id` (url/label/active), `DELETE /webhook-endpoints/:id` with pending-dead-lettering per design D5; annotate for Swagger — verify with e2e tests (`test/webhook-endpoints.e2e-spec.ts`) covering tenant scoping, secret-once behaviour, and delete-dead-letters-pending.
- [x] 2.2 Implement the HMAC-SHA256 signer `packages/core/src/webhooks/webhook-signer.ts` (sign exact raw bytes, headers per design D4) with unit tests — verify a known vector (secret + body + expected hex) and document the verification algorithm in the Swagger description for the create endpoint.

## 3. Delivery relay

- [x] 3.1 Implement `webhook-http.client.ts` (Node fetch wrapper, 10 s timeout) and `webhook-relay.service.ts` in `packages/core/src/webhooks/`: claim due PENDING rows with `FOR UPDATE SKIP LOCKED` batch, POST signed body, classify `2xx`/`4xx`/transient per design D6, write append-only `webhook_delivery_attempts` rows, apply exponential backoff (`next_attempt_at`), and dead-letter on 4xx/exhaustion/`endpoint_removed` — unit-test classification, backoff sequence, and attempt-row append-mock behaviour. **Reliability-critical: append-only audit + non-blocking-of-event-commit contract.**
- [x] 3.2 Register the relay in `packages/core/src/worker/worker.module.ts` only (not the API module) with config knobs `WEBHOOK_RELAY_ENABLED/INTERVAL_MS/BATCH_SIZE/MAX_ATTEMPTS` and `WEBHOOK_DELIVERY_TIMEOUT_MS` from `packages/core/src/config` — verify the worker boots with the relay in `docker compose up` and respects `WEBHOOK_RELAY_ENABLED=false` (loop inert).

## 4. Delivery observability API and e2e

- [x] 4.1 Add read endpoints `GET /webhook-endpoints/:id/deliveries` + `GET /webhook-deliveries/:id` (state, event, terminal status, denormalized url, attempt trail; tenant-scoped) with Swagger annotations — e2e-verify an integrator queries deliveries for its org only.
- [x] 4.2 Full-path e2e (`test/webhook-delivery.e2e-spec.ts`) against a stub HTTP receiver: register endpoint → submit event → await terminal state → assert the stub received a POST whose signature verifies against the create-time secret and whose body matches the event's terminal outcome; flip the stub to 503-then-200 to assert backoff redelivery; switch to 410 to assert dead-letter with attempt trail — verify terminal event state/row remain untouched throughout every delivery failure. **Reliability-critical integration check.**
- [x] 4.3 Update the README integration section, run `pnpm lint` + `pnpm test` (backend unit + e2e + frontend suites) in CI parity — verify all suites green and the new tests are registered in the CI workflow.
