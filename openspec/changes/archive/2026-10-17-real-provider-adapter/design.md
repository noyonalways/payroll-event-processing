# Design

## Context

Handlers in `packages/core/src/processing/handlers/` constructor-inject
`SimulatedPayrollProvider` directly and call `this.provider.simulate({ employeeId, attempt })` —
a 2-line seam. The provider raises `TransientPayrollFailureError`/`PermanentPayrollFailureError`
(`@repo/shared`), and the handler's contract (provider call first, then
`EmployeeDomainStateWriter` through the claim's transaction client) preserves exactly-once
behaviour (domain-effects D2; R4/R5). Overriding env-configured failure modes for deterministic
tests is already solved in `FailureConfig`. The claim transaction and retries treat the two error
classes as the only signals. `@repo/database` owns Prisma; the worker composition root is
`packages/core/src/worker/worker.module.ts`.

## Goals / Non-Goals

**Goals:**

- Per-organization provider resolution with zero changes to the claim, retry, or audit paths —
  the classification contract over `@repo/shared` error classes is the only coupling.
- Credential handling identical to webhook secrets: write-response-once, never in reads/logs.

**Non-Goals:**

- Vendor SDK integrations, per-event-type provider routing, provider-configuration UI,
  simulated-mode behaviour changes.

## Decisions

### D1 — One interface, two implementations, one resolver

`packages/core/src/processing/external-payroll-provider.ts` (new interface mirroring the current
`simulate` surface, renamed `apply`): `SimulatedPayrollProvider` keeps its class and all env
behaviour but now plays the default implementation; new `http-payroll-provider.ts` implements the
same interface. New `provider-resolver.service.ts` reads the org's `provider_configs` row (mode +
URL + credential) and returns the implementation — simulated when absent or `SIMULATED`. A
request-scoped/contrast-indifferent lookup happens once per handler invocation; per-call
resolution (not bootstrap-time DI) is what makes config changes effective without restart (spec
scenario). Handlers' constructor type changes to the interface; Nest token binding goes through a
provider-factory exporting `EXTERNAL_PAYROLL_PROVIDER` + the resolver — no handler bodies
change beyond the injected symbol.

### D2 — New `provider_configs` table (migration in `packages/database/prisma/migrations/`)

`id` (uuid pk), `organization_id` (FK, unique — one config per org), `mode` (enum `SIMULATED`,
`HTTP`), `base_url` (text, https for HTTP mode), `credential` (text, stored recoverable — sent as
the authorization header on every call; write-response-once like webhook secrets), `created_at`,
`updated_at`. One row per org (unique constraint) keeps resolution O(1) and makes "remove HTTP"
== delete row / set `SIMULATED`. No indexes beyond the unique FK needed (resolution is by exact
org). Integrated into the simulated claim path WITHOUT schema changes to events/attempts — the
attempt trail keeps the same columns; `result.reference` simply carries the external reference.

### D3 — Management endpoints, OWNER-gated

`packages/core/src/processing/provider-config.controller.ts` + service + DTOs:
`PUT /provider-config` (create/replace; returns credential once), `GET /provider-config`
(redacts credential), `DELETE /provider-config`. All annotated `@Roles(OWNER)` — replacing the
provider is owner-equivalent to changing who executes payroll; admins/members get `403` per the
access-control matrix. Guarded precedence: `real process.env` override convention from
`FailureConfig` is respected for the simulated modes; HTTP config lives purely in the DB.

### D4 — HTTP adapter contract and classification (the reliability core)

`http-payroll-provider.ts` posts `{ employeeId, eventType, sequence, payload, attempt, eventId }`
plus `Authorization: Bearer <credential>` to `{base_url}` with a 10 s timeout
(`PROVIDER_HTTP_TIMEOUT_MS`), reusing the webhook change's `fetch`-client pattern (thin
injectable client, fully mockable). Classification: `2xx` + non-empty string `reference` ⇒
success `{ reference }`; `2xx` without reference, network error, timeout, `5xx` ⇒
`TransientPayrollFailureError` (reason recorded in the `retrying` log line as today); `4xx` ⇒
`PermanentPayrollFailureError` carrying the provider's `message`/body excerpt as the failure
reason (bounded length, credential never included). Response body parse failures on `2xx` are
transient (server answered wrong, may answer right on retry); on `4xx` are permanent with a
generic reason. Rationale: reliability concept 1 — the adapter's entire job is translating
protocol into the two classes the claim already understands; nothing downstream may branch on
provider identity (concept 7 keeps handler extensibility intact).

### D5 — Request column transparency

No new attempt/audit columns: which provider ran is observable through the committed result
reference and the structured `started`/`succeeded` log lines (extend the exact-once logging
requirement's lines with `provider: 'simulated'|'http'`), keeping `event_attempts` append-only
shape stable. Alternative (a `provider` column on attempts) rejected as audit-schema churn with
no consumer.

## Risks / Trade-offs

- [Real endpoint latency extends claim transactions] → hard 10 s timeout bounds the transaction
  (claim tx has its own 10 s ceiling); retries handle transient overrun; backoff prevents hammering
  a slow endpoint.
- [Credential leakage into logs via error bodies] → adapter sanitizes provider response excerpts
  (bounded, header-stripped); logger error context never includes the authorization header;
  credential returned once on write.
- [Org switches provider while events are in flight] → resolution happens per handler invocation;
  an in-flight event finished under the provider resolved at its start — acceptable, transactions
  are mutually exclusive per employee anyway.
- [HTTP provider misbehaving floods retries] → existing exhaustion + dead-letter cover it; the
  permanent classification for 4xx keeps business rejections out of the retry loop.

## Migration Plan

Additive migration (new table); handlers rewire injection to the interface token (behaviour-
identical when no config rows exist — resolution defaults to simulated). Deploy API + worker
together. Rollback: delete config rows + revert the module registration; simulated resumes.

## Open Questions

None.
