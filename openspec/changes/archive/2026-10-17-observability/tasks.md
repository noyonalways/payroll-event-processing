# Tasks

## 1. Metrics core

- [x] 1.1 Build `packages/core/src/telemetry/` (metrics module + registry service with the D2 inventory: HTTP request metrics via an interceptor keyed on route patterns, event lifecycle counters wired at submission and terminal-commit call sites, attempt counters, processing duration histogram) — unit-test label cardinality (no org/employee/event ids in any series) and counter increments; verify instrumentation never throws into callers. **Reliability-adjacent: fail-soft recording on the critical path.**
- [x] 1.2 Add `GET /metrics` to the API (`@Public`, same posture as `/health`) and a standalone metrics listener to the worker (`WORKER_METRICS_PORT`) — unit/integration-test: Prometheus-format response is parseable, worker port serves queue gauges, and cache misses produce bounded `route` labels.

## 2. Queue and worker gauges

- [x] 2.1 Implement the queue gauge poller (`payroll_queue_jobs{state}` via the existing BullMQ handle, stalled counter via the stalled-event listener, per design D2) with failure-tolerant polling (`payroll_queue_metrics_errors_total`) — integration test with real Redis: counts track enqueued/processed jobs; Redis-down keeps last values.
- [x] 2.2 Implement `payroll_worker_heartbeats_stale` (reusing the `/health` staleness threshold env) and the webhook delivery outcome counter hook (compiles and no-ops until `integrator-webhooks` lands; wire if it is already applied) — verify stale-heartbeat gauge transitions in the heartbeat spec.

## 3. Tracing and error tracking (env-gated)

- [x] 3.1 Add `instrument.ts` entrypoint bootstrap + `tracing.ts` (SDK-node + auto-instrumentations + Prisma instrumentation, OTLP exporter, import-time gate) in both API and worker entrypoints — integration test with tracing enabled against an in-process OTLP collector stub: HTTP span on request; disabled-by-default path asserts no exporter construction.
- [x] 3.2 Propagate trace context through the queue producer into the worker (additive optional job-payload context, try/catch both sides per design D3) — unit-test: corrupt context yields fresh root span and processing proceeds; existing queue producer specs still pass unchanged. **Reliability-critical: enqueue contract (2s best-effort) must not regress.**
- [x] 3.3 Add `error-tracking.ts` (`@sentry/nestjs` API / `@sentry/node` worker, DSN-gated) with `beforeSend` scrubbing and global-filter + processor/relay error hooks — unit-test scrubbing (no email/password/token/credential in payload), 4xx non-reporting, and fail-soft behaviour when the tracker transport throws.

## 4. Compose profile, rules, and runbook

- [x] 4.1 Add the `monitoring/` artifacts: `prometheus.yml` (scrape api + worker), `rules.yml` (queue depth, stalled, worker liveness, terminal error rate, dead-letter, scrape errors — per the observability spec), Grafana provisioning (datasource + starter dashboard), and `monitoring/README.md` runbook with thresholds and first checks — verify rules parse (`promtool check rules` or CI container step) and reference only exposed series.
- [x] 4.2 Extend `docker-compose.yml` with the `observability` profile (prometheus, grafana, jaeger all-in-one OTLP) — verify `docker compose config` shows identical default service set without the profile and the extra three with it; live-check `docker compose --profile observability up` serves the dashboard and rules load.
- [x] 4.3 Append all new env vars to `apps/api/.env.example` (and worker env docs) with comments per the infrastructure-setup documentation requirement — verify the env example lint/check (or manual diff list) covers: METRICS_ENABLED, WORKER_METRICS_PORT, METRICS_QUEUE_POLL_MS, OTEL_*, SENTRY_*, GIT_SHA.

## 5. Verification

- [x] 5.1 e2e `test/metrics.e2e-spec.ts`: scrape /metrics during a submit→process cycle (deterministic failure mode) asserting submitted/terminal/attempt series and queue gauges change; assert absence of identifier labels; run the alerting scenario by importing rules into a promtool/prometheus container — verify the queue-depth rule fires on an over-threshold fixture.
- [x] 5.2 CI parity: `pnpm lint`, backend unit + e2e, frontend untouched; add `promtool` rule check job — verify all green.
