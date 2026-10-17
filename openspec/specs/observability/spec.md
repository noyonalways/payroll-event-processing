# observability Specification

## Purpose

Make the service operable from the outside: pull metrics for HTTP, event lifecycle, queue, and
worker health; optional distributed tracing; optional error capture; and shipped alert rules that
turn queue depth and stalls into actionable signals.

## Requirements

### Requirement: Both processes expose Prometheus metrics without tenant data

The API SHALL expose `GET /metrics` in Prometheus exposition format on its existing port, and the
worker SHALL expose the same surface on a dedicated local port — both credential-free in the same
posture as `GET /health` (service-health only, no organization-owned data, no organization
identifier accepted). Exposed metrics SHALL include: HTTP request count and duration by route
pattern, method, and status class; event submissions by type; processing outcomes by event type
and terminal status; processing attempt counters by error type (transient, permanent);
processing duration histogram; queue depth gauges (waiting, active, completed, failed, delayed,
stalled); worker heartbeat staleness; and webhook delivery outcome counters. Labels SHALL be
bounded-cardinality only — names, types, statuses, and outcome classes — never organization,
employee, or event identifiers. Metric recording SHALL be fail-soft: instrumentation errors and
Redis polling failures SHALL increment a scrape-error counter and SHALL NOT raise, crash, or
delay request handling or event processing.

#### Scenario: Metrics scrape serves the pipeline
- **WHEN** Prometheus scrapes the API metrics endpoint while events are being submitted and processed
- **THEN** the response SHALL be Prometheus-formatted text containing the documented lifecycle, queue, and HTTP series with bounded labels

#### Scenario: Worker process is metered without serving the API
- **WHEN** the worker process runs and its metrics port is scraped
- **THEN** processing outcome counters, queue depth gauges, and heartbeat staleness SHALL be exposed from the worker process

#### Scenario: No tenant identifiers leak into labels
- **WHEN** any metric series is inspected
- **THEN** no label value SHALL contain an organization, employee, or event identifier

#### Scenario: Redis outage cannot take down instrumentation
- **WHEN** Redis is unreachable during queue-count polling
- **THEN** the gauges SHALL report their last known values or zero with the scrape-error counter incremented, and the worker and API SHALL continue processing normally
### Requirement: Distributed tracing is available and disabled by default

The system SHALL support OpenTelemetry tracing in both processes with automatic instrumentation
of HTTP handling, Prisma/Postgres queries, and Redis/BullMQ operations, exporting OTLP to an
endpoint configured by environment. Tracing SHALL be disabled unless explicitly enabled by
environment, and enabling or disabling SHALL require no code change. An event's trace context
SHALL propagate from the submitting API request through the BullMQ job into the worker's
processing spans via additive, best-effort context injection in the job payload; a failure to
inject or extract context SHALL never fail submission, enqueue, or processing.

#### Scenario: Tracing disabled yields zero overhead paths changed
- **WHEN** the service runs without tracing environment configuration
- **THEN** submission, processing, and health behaviour SHALL be identical to non-traced deployments and no exporter SHALL network

#### Scenario: An event's traces link request to processing
- **WHEN** tracing is enabled and an event is submitted, enqueued, and processed
- **THEN** the worker's processing span SHALL be a descendant of (or linked to) the submitting request's trace, and PostgreSQL and Redis spans SHALL appear within it

#### Scenario: Corrupt trace payload cannot break the queue
- **WHEN** a job payload carries malformed trace context
- **THEN** processing SHALL proceed normally with a fresh root span and the malformed data SHALL be logged structurally
### Requirement: Unhandled errors are captured by an opt-in error tracker

The system SHALL integrate an error-tracking service in both processes that captures unhandled
request exceptions, handler failures that reach a terminal outcome, relay/worker crashes, and
uncaught process errors. Capture SHALL be disabled unless an environment DSN is configured and
SHALL attach non-PII context (process name, release/version, event and organization identifiers
as identifiers only — never emails, passwords, tokens, or provider credentials). The integration
SHALL be fail-soft: tracker unavailability SHALL never alter an API response or processing
outcome.

#### Scenario: Terminal processing failure reaches the tracker
- **WHEN** the error tracker is configured and a handler raises a permanent failure
- **THEN** the tracker SHALL receive the error with the event context tags, while the event still commits `failed` exactly as without the tracker

#### Scenario: Tracker outage changes nothing
- **WHEN** the tracker endpoint is unreachable
- **THEN** responses and processing outcomes SHALL be unaffected and the failure SHALL appear only in local logs

#### Scenario: Secrets and PII are scrubbed
- **WHEN** any error payload is captured
- **THEN** passwords, access or refresh tokens, provider credentials, and user emails SHALL be absent from the tracker payload
### Requirement: Queue saturation and failure signals ship as alertable rules

The repository SHALL ship Prometheus alert rules and an operational runbook covering: event-queue
depth or age beyond configured thresholds, stalled jobs present, no live (non-stale) worker
heartbeat, sustained error-rate increase on terminal outcomes, dead-lettered webhook deliveries
present, and metrics scrape failures. The rule file SHALL reference only metrics the system
actually exposes and SHALL carry documented starting-point thresholds and for-each durations.
A `docker compose --profile observability up` SHALL additionally start Prometheus with these
rules loaded and Grafana with a provisioned datasource and starter dashboard, without changing
the default (profile-less) composition.

#### Scenario: Queue back-pressure is alertable
- **WHEN** the waiting-job gauge of the payroll queue stays above the documented threshold for the documented duration
- **THEN** the shipped rule for queue depth SHALL be in `firing` state in Prometheus

#### Scenario: Lost worker is alertable
- **WHEN** no worker heartbeat is fresh for the documented window
- **THEN** the shipped worker-liveness rule SHALL fire

#### Scenario: Default compose surface is unchanged
- **WHEN** `docker compose up` runs without the observability profile
- **THEN** the running service set SHALL be exactly as before this change
