# Design

## Context

The API serves HTTP on its own port; the worker (`apps/worker`) is a standalone BullMQ process
with no HTTP listener — it already reports liveness via the `worker_heartbeats` table surfaced by
`GET /health` (health-check spec). The critical paths (submission, claim transaction, SSE) are
log-structured today via the Nest built-in JSON logger. `@repo/core` hosts both composition
roots; `@repo/database` owns clients. The event queue's counts are obtainable from the existing
BullMQ `Queue` handle (`getJobCounts`); stalled counts come from BullMQ events/`getJobCounts`
('stalled' is surfaced through failed-with-reason + queue events — see D2 note).

## Goals / Non-Goals

**Goals:**

- One shared telemetry module; both processes pull from it; zero opt-in cost when disabled.
- Bounded label cardinality so a busy org cannot blow up Prometheus (reliability posture of the
  monitoring system itself).

**Non-Goals:**

- SLOs, paging integrations, log pipelines, dashboards beyond a starter, profiling.

## Decisions

### D1 — `prom-client` registry per process; pull endpoints, no pushgateway

`packages/core/src/telemetry/` (new): `metrics.module.ts`, `metrics.service.ts` (registry +
instruments), `metrics.controller.ts` (API `GET /metrics` via the same `@Public()` posture as
`/health`), and a standalone `http.server.ts` in the worker composition root
(`WORKER_METRICS_PORT`, default 9101, binds 0.0.0.0 for container scraping). Pull over
Pushgateway: pull is the Prometheus-native path and adds no moving part; the worker has no port
conflict risk on a dedicated port. Env: `METRICS_ENABLED` (default true), `WORKER_METRICS_PORT`.

### D2 — Metric inventory (names prefixed `payroll_`, labels bracketed)

- `payroll_http_requests_total{route,method,status_class}` + `..._duration_seconds{route,method}`
  (histogram, route = controller route pattern, not raw path — the data cache keyed by the
  matcher, so no cardinality leak from ids).
- `payroll_events_submitted_total{event_type}`.
- `payroll_events_terminal_total{event_type,status}` (SUCCESS/FAILED/CANCELLED).
- `payroll_processing_attempts_total{error_type}` (TRANSIENT/PERMANENT/none).
- `payroll_processing_duration_seconds{event_type}` histogram; retry log-line semantics stay
  authoritative (spec's logging requirement untouched).
- `payroll_queue_jobs{state}` gauge (waiting/active/completed/failed/delayed) polled every
  `METRICS_QUEUE_POLL_MS` (default 5000) through the existing queue handle on the shared config;
  polling failures set `payroll_queue_metrics_errors_total` and keep last values.
- `payroll_worker_heartbeats_stale` gauge (count of stale heartbeats, same threshold env as
  `/health`).
- `payroll_webhook_deliveries_total{outcome}` (DELIVERED/DEAD_LETTERED) — wired once
  `integrator-webhooks` has landed (it precedes this item in the queue).
Stalled jobs: BullMQ exposes stalled counts only via events/`getJobState` scanning; the gauge is
maintained from `worker_heartbeats` + the stalled-event listener incrementing
`payroll_queue_stalled_total` (counter) — depth alerting keys off waiting+delayed and the
stalled counter, matching what the health endpoint already trusts. No tenant labels anywhere
(cardinality ceiling stated in spec scenarios).

### D3 — OpenTelemetry OFF by default, additive propagation

`packages/core/src/telemetry/tracing.ts` initializes `@opentelemetry/sdk-node` +
`@opentelemetry/auto-instrumentations-node` (http, ioredis, express) + `@prisma/instrumentation`
when `OTEL_TRACES_ENABLED=true`, exporting OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` (default
collector URL `http://jaeger:4318` in the compose profile). Gated at import time in both
entrypoints (`instrument.ts` imported first), so a disabled run cannot even construct exporters.
Context across BullMQ: the queue producer injects the active trace context into
`job.opts`/payload via the standard propagator inside a try/catch (additive optional field —
the existing "enqueue is best-effort, never blocks submission" contract is preserved and the
worker extracts it likewise). Corrupt context → fresh root span + structured log (spec).

### D4 — Sentry via `@sentry/nestjs` (API) and `@sentry/node` (worker), DSN-gated

`telemetry/error-tracking.ts` init in both entrypoints: `SENTRY_DSN` absent ⇒ no-op (same
import-time gate). API: global exception filter hook reports status-`5xx`/unhandled only (4xx
client errors stay out — they're log events, not incidents). Worker: reports terminal
`permanent-failure` handler errors, exhausted retries, relay crashes, `uncaughtException`/
`unhandledRejection` hooks. Scrubbing: global `beforeSend` strips `email`, `password`, `password_hash`,
tokens, provider credentials, and configuration headers; tags: `process` (`api`|`worker`),
`release` (`GIT_SHA` env), and identifiers (`eventId`,`organizationId`) as tags only.
Fail-soft: all reporting wrapped so tracker failure can never rethrow (spec).

### D5 — Compose profile + alerting artifacts

`docker-compose.yml` gains an `observability` profile: `prometheus` (mounts
`monitoring/prometheus.yml` + `monitoring/rules.yml`), `grafana` (provisioned datasource +
starter dashboard under `monitoring/grafana/provisioning/`), `jaeger` (all-in-one, OTLP enabled).
Default profile-less `up` is byte-identical in service set (spec scenario). `monitoring/rules.yml`
requires only D2/D4-alerting gauges and counters, with starting thresholds in
`monitoring/README.md` (runbook: what each rule means, first checks). This satisfies the
already-archived `infrastructure-setup` convention that `.env.example` documents every optional
var — the new vars are appended there, not spec-modified.

## Risks / Trade-offs

- [Queue-count polling costs Redis round-trips] → one `getJobCounts` call per interval per
  process; failure-tolerant; interval configurable.
- [Auto-instrumentation overhead] → zero when disabled (import-time gate); when enabled, SDK
  sampling defaults (parent-based, 1.0 low-traffic assumption, configurable via standard
  `OTEL_TRACES_SAMPLER_ARGS`).
- [Route-pattern label collisions] → counts keyed on the canonical route pattern; integration
  test asserts no raw ids in series.
- [Compose profile drift vs prod deploy] → profile purely for local/ops tooling; production
  deploys run their own Prometheus (rules file is portable).

## Migration Plan

Additive: new module/wiring (inactive unless env-gated exporters are set), one optional compose
profile, new env vars documented. No schema migration at all. Rollback: unset envs / remove
profile; the shared module is inert.

## Open Questions

None — threshold tuning is runbook content, not design.
