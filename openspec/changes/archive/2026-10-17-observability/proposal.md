# Proposal

## Why

Operations today are blind beyond `GET /health` and JSON log lines: nothing answers "how deep is
the queue right now", "how often do events fail permanently", or "why did that request fail" —
the structured logs exist but nothing aggregates, charts, or alerts on them. Item 11 was scoped
as CI/docs and shipped without metrics, tracing, or error capture; the queue-depth alerting gap
is called out explicitly in the feature queue as part of the hardening story.

## What Changes

- **Prometheus metrics**: `GET /metrics` on the API (health-endpoint posture: credential-free,
  organization-free) and a lightweight metrics listener on the worker (`WORKER_METRICS_PORT`);
  application metrics for HTTP requests, event lifecycle outcomes, processing duration, retries,
  queue depth/active/waiting/stalled, worker heartbeat staleness, and (behind their queued
  changes) webhook delivery outcomes — bounded-cardinality labels only (no tenant identifiers).
- **OpenTelemetry tracing**: env-gated (`OTEL_*`, off by default) Node SDK in both processes with
  auto-instrumentation for HTTP, Prisma/Postgres, and Redis/BullMQ; an event's trace context
  propagates producer → BullMQ job → worker via best-effort context injection in the job payload;
  OTLP export to a configurable collector endpoint.
- **Error tracking**: env-gated Sentry integration (`SENTRY_DSN`, off by default) in API and
  worker capturing unhandled failures — global exception filter and processor/consumer error
  paths — with PII scrubbing (emails, tokens, credentials) and process/release tags.
- **Queue-depth alerting**: shipped Prometheus alert-rule file and runbook built on the exposed
  gauges (depth age, stalled jobs, stale workers, error rates) plus an optional
  `observability` Docker Compose profile (Prometheus, Grafana with provisioned starter
  dashboard/datasource, and a trace collector) — default `docker compose up` unchanged.
- Metrics and exporters are fail-soft on the critical paths: recording is in-memory; queue-count
  polling is periodic and Redis-failure tolerant (scrape-error counter, never a crash).

## Capabilities

### New Capabilities
- `observability`: Metrics, tracing, and error tracking for both processes — the metrics
  surface and its cardinality posture, the gated tracing pipeline, gated error capture, and the
  alerting artifacts built on them.

## Impact

- **API/worker**: new shared `telemetry` module in `packages/core/src` (registry, instruments,
  interceptors, health of metrics listener in the worker composition root); a small instrumentation
  bootstrap in both app entrypoints; global exception filter gains an error-tracking hook.
- **Queue producer**: optional additive field in BullMQ job payload for trace context
  (best-effort, never blocks or changes the enqueue contract).
- **Docker/deploy**: `docker-compose.yml` gains a `profiles: ["observability"]` section
  (prometheus/grafana/collector); new env vars documented in `apps/api/.env.example` per the
  infrastructure-setup spec's existing documentation requirement.
- **New files**: `monitoring/prometheus.yml` + `monitoring/rules.yml` + Grafana provisioning.
- **Existing specs**: none modified — `/health` semantics are untouched; the metrics endpoint is
  a new surface beside it.

## Non-goals

- No SLO/error-budget definitions or paging-service integrations (PagerDuty/Slack) — alert rules
  and a runbook are the shipped artifacts.
- No log aggregation pipeline (structured JSON logs remain the log story).
- No curated dashboard library — one starter Grafana dashboard and datasource provisioning only.
- No metric dimensions by tenant (deliberate cardinality ceiling; per-org drill-down stays in the
  relational API).
- No profiling (continuous profiler) in this change.
