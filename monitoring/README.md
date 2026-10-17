# Observability runbook (observability)

Alert rules live in `rules.yml`; every expression references only `payroll_*`
series the pipeline exposes. Thresholds here are documented STARTING POINTS —
tune them against your own traffic before paging anyone.

## Queue backlog — `PayrollQueueBacklog`

Fires when `waiting + delayed` jobs stay above 100 for 10 minutes. First
checks: is a worker alive (`payroll_worker_heartbeats_stale == 0`)? Is Redis
reachable from the worker? A stuck handler will back this up — check
`payroll_processing_duration_seconds` for inflating latency and the
`event_attempts` trail of the oldest queued event.

## Worker liveness — `PayrollWorkerLivenessLost`

Fires when any heartbeat is stale for 2 minutes (`payroll_worker_heartbeats_stale
>= 1`). This is the same threshold `GET /health` degrades on. Live recovery:
restart the worker; the guarded claim + BullMQ stalled-job detection make the
in-flight event safe to re-claim.

## Stalled jobs — `PayrollQueueStalledJobs`

Any `payroll_queue_stalled_total` increase inside 10m means BullMX detected a
dead worker mid-job and re-queued it. Correlate with
`PayrollWorkerLivenessLost`; occasional 1s is a deploy restart, sustained
fires mean a worker is wedged or lockDuration is mis-tuned.

## Terminal failures — `PayrollTerminalFailureSpike`

`rate(payroll_events_terminal_total{status="FAILED"}[15m]) > 0.2`. Break down
by `event_type`; check `payroll_processing_attempts_total{error_type="PERMANENT"}`
(business rejections, likely provider-side) vs TRANSIENT (endpoint availability).

## Webhook dead letters — `PayrollWebhookDeadLetters`

Any dead-lettered delivery in 30m. Inspect via `GET
/webhook-deliveries/:id` — the attempt trail lists each POST's response status
or transport error. Dead letters are terminal by design: fix the endpoint, then
re-register/re-tune (no automatic replay yet — see the change's non-goals).

## Metrics scrapes — `PayrollMetricsScrapesFailing`

`payroll_queue_metrics_errors_total` increasing means the worker cannot reach
Redis or the DB for gauge polling. Gauges hold their LAST values (fail-soft) —
treat them as stale, fix connectivity; the pipeline itself keeps running.
