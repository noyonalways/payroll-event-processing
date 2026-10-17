import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * The Prometheus registry + application instruments (observability design D2).
 * One registry per process; both the API and the worker construct this
 * service. Labels are BOUNDED-CARDINALITY ONLY — route patterns, event types,
 * statuses, outcome classes — never organization, employee, or event
 * identifiers (the spec's cardinality ceiling). `METRICS_PROCESS_NAME`
 * distinguishes `api` from `worker` series in the same scraper view.
 */

/** Extracts the canonical route pattern (e.g. `/events/:id`) or a fallback. */
export function routeLabelOf(request: {
  route?: { path?: string; baseUrl?: string };
  method?: string;
}): string {
  const route = request.route;
  if (route?.path) {
    const base = route.baseUrl ?? '';
    return `${base}${route.path}`;
  }
  return 'unmatched';
}

const statusClassOf = (status: number): string => `${Math.floor(status / 100)}xx`;

@Injectable()
export class MetricsService {
  readonly registry: Registry;

  private readonly httpRequestsTotal;
  private readonly httpRequestDuration;
  private readonly eventsSubmittedTotal;
  private readonly eventsTerminalTotal;
  private readonly processingAttemptsTotal;
  private readonly processingDuration;
  private readonly queueJobs;
  private readonly queueMetricsErrorsTotal;
  private readonly queueStalledTotal;
  private readonly workerHeartbeatsStale;
  private readonly webhookDeliveriesTotal;

  constructor(config: ConfigService) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({
      process_name: config.get<string>('METRICS_PROCESS_NAME') ?? 'api',
    } as never);

    this.httpRequestsTotal = new Counter({
      name: 'payroll_http_requests_total',
      help: 'HTTP requests by canonical route pattern, method, and status class.',
      labelNames: ['route', 'method', 'status_class'],
      registers: [this.registry],
    });
    this.httpRequestDuration = new Histogram({
      name: 'payroll_http_request_duration_seconds',
      help: 'HTTP request duration by canonical route pattern and method.',
      labelNames: ['route', 'method'],
      registers: [this.registry],
    });
    this.eventsSubmittedTotal = new Counter({
      name: 'payroll_events_submitted_total',
      help: 'Payroll events accepted through submission.',
      labelNames: ['event_type'],
      registers: [this.registry],
    });
    this.eventsTerminalTotal = new Counter({
      name: 'payroll_events_terminal_total',
      help: 'Committed terminal transitions by event type and status.',
      labelNames: ['event_type', 'status'],
      registers: [this.registry],
    });
    this.processingAttemptsTotal = new Counter({
      name: 'payroll_processing_attempts_total',
      help: 'Processing attempts by error class (NONE, TRANSIENT, PERMANENT).',
      labelNames: ['error_type'],
      registers: [this.registry],
    });
    this.processingDuration = new Histogram({
      name: 'payroll_processing_duration_seconds',
      help: 'End-to-end processing duration (claim to terminal commit).',
      labelNames: ['event_type'],
      registers: [this.registry],
    });
    this.queueJobs = new Gauge({
      name: 'payroll_queue_jobs',
      help: 'BullMQ job counts by queue state (waiting, active, completed, failed, delayed).',
      labelNames: ['state'],
      registers: [this.registry],
    });
    this.queueMetricsErrorsTotal = new Counter({
      name: 'payroll_queue_metrics_errors_total',
      help: 'Failed queue-count polls — the pipeline keeps running (fail-soft).',
      registers: [this.registry],
    });
    this.queueStalledTotal = new Counter({
      name: 'payroll_queue_stalled_total',
      help: 'BullMQ stalled-job detections observed by the worker.',
      registers: [this.registry],
    });
    this.workerHeartbeatsStale = new Gauge({
      name: 'payroll_worker_heartbeats_stale',
      help: 'Count of worker heartbeats older than HEALTH_WORKER_STALE_MS.',
      registers: [this.registry],
    });
    this.webhookDeliveriesTotal = new Counter({
      name: 'payroll_webhook_deliveries_total',
      help: 'Webhook delivery outcomes (DELIVERED, DEAD_LETTERED).',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
  }

  // ── HTTP (interceptor) ───────────────────────────────────────────────────

  /**
   * Records an HTTP request COUNT only. Guard- and filter-level statuses
   * (401 before the controller, validation 400s) never reach interceptors —
   * the exception filter records those, so this counter is the SINGLE writer
   * (no double counting across paths).
   */
  recordHttpCount(
    request: { route?: { path?: string; baseUrl?: string }; method?: string },
    status: number,
  ): void {
    const route = routeLabelOf(request);
    const method = request.method ?? 'GET';
    this.httpRequestsTotal.labels(route, method, statusClassOf(status)).inc();
  }

  /** Duration-ONLY writer for the interceptor's error tap (no count — the
   *  exception filter owns the status; see the filter's recordHttpCount). */
  recordHttpDurationOnly(
    request: { route?: { path?: string; baseUrl?: string }; method?: string },
    seconds: number,
  ): void {
    this.httpRequestDuration
      .labels(routeLabelOf(request), request.method ?? 'GET')
      .observe(seconds);
  }

  /** Records duration (and count — full-path requests) for reached handlers. */
  recordHttp(
    request: { route?: { path?: string; baseUrl?: string }; method?: string },
    status: number,
    seconds: number,
  ): void {
    this.recordHttpCount(request, status);
    const method = request.method ?? 'GET';
    this.httpRequestDuration.labels(routeLabelOf(request), method).observe(seconds);
  }

  // ── Event lifecycle ──────────────────────────────────────────────────────

  recordSubmitted(eventType: string): void {
    this.eventsSubmittedTotal.labels(eventType).inc();
  }

  recordTerminal(
    eventType: string,
    status: 'SUCCESS' | 'FAILED' | 'CANCELLED',
  ): void {
    this.eventsTerminalTotal.labels(eventType, status).inc();
  }

  recordAttempt(errorType: 'NONE' | 'TRANSIENT' | 'PERMANENT'): void {
    this.processingAttemptsTotal.labels(errorType).inc();
  }

  observeProcessing(eventType: string, seconds: number): void {
    this.processingDuration.labels(eventType).observe(seconds);
  }

  // ── Queue / worker / webhooks ────────────────────────────────────────────

  setQueueCounts(counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }): void {
    for (const [state, value] of Object.entries(counts)) {
      this.queueJobs.labels(state).set(value);
    }
  }

  recordQueueMetricsError(): void {
    this.queueMetricsErrorsTotal.inc();
  }

  recordStalled(): void {
    this.queueStalledTotal.inc();
  }

  setStaleHeartbeats(count: number): void {
    this.workerHeartbeatsStale.set(count);
  }

  recordWebhookDelivery(outcome: 'DELIVERED' | 'DEAD_LETTERED'): void {
    this.webhookDeliveriesTotal.labels(outcome).inc();
  }

  /** Prometheus exposition text (the /metrics body in both processes). */
  async renderMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
