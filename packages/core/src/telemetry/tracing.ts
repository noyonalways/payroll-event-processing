import { Logger } from '@nestjs/common';

/**
 * Distributed tracing bootstrap (observability design D3) — imported FIRST in
 * both entrypoints, BEFORE any application module. Zero-config OFF: without
 * OTEL_TRACES_ENABLED=true nothing is constructed, no exporter can network,
 * and tracing is statically absent from the process.
 */
const logger = new Logger('TelemetryTracing');

export async function initTracing(): Promise<void> {
  if (process.env.OTEL_TRACES_ENABLED !== 'true') {
    return;
  }

  // Dynamic imports keep the SDK out of the disabled runtime entirely.
  const [{ NodeSDK }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
  ]);
  const {
    getNodeAutoInstrumentations,
  } = await import('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = await import(
    '@opentelemetry/exporter-trace-otlp-http'
  );

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'payroll-service',
    traceExporter: new OTLPTraceExporter({
      url:
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
        'http://localhost:4318/v1/traces',
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs is noise for this service; HTTP + ioredis + Prisma are the story.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  logger.log('OpenTelemetry tracing enabled (OTLP exporter)');
}

/** Queue-payload key carrying the producer's trace context. */
export const TRACE_CONTEXT_KEY = 'otelTraceContext';

/**
 * Producer side (best-effort): returns a propagation carrier for the CURRENT
 * active span (the submitting HTTP request, when tracing is on) — `null`
 * signals "inject nothing". Never throws: enqueue must not care (R2, spec).
 */
export function traceContextForJob(): Record<string, string> | null {
  try {
    if (process.env.OTEL_TRACES_ENABLED !== 'true') {
      return null;
    }
    const { context, trace, propagation } = traceApi();
    const span = trace.getSpan(context.active());
    if (!span) {
      return null;
    }
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return Object.keys(carrier).length > 0 ? carrier : null;
  } catch {
    return null;
  }
}

function traceApi(): typeof import('@opentelemetry/api') {
  return require('@opentelemetry/api') as typeof import('@opentelemetry/api');
}

/**
 * Worker side (best-effort): resumes the propagated context (if any, even a
 * corrupt one — a fresh root span then) and runs `fn` inside a processing
 * span with the event's bounded identity attributes. Failures in the span
 * machinery never reach the pipeline: any error falls back to plain `fn()`.
 */
export async function withJobSpan<T>(
  eventType: string,
  eventId: string,
  organizationId: string,
  carrier: Record<string, string> | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.env.OTEL_TRACES_ENABLED !== 'true') {
    return fn();
  }
  try {
    const { context, propagation, trace } = traceApi();
    const tracer = trace.getTracer('payroll-processor');
    const parent = carrier
      ? propagation.extract(context.active(), carrier)
      : context.active();
    const spanName = `process ${eventType}`;
    return await tracer.startActiveSpan(
      spanName,
      { attributes: {
          'payroll.event_id': eventId,
          'payroll.organization_id': organizationId,
          'payroll.event_type': eventType,
        } },
      parent,
      async (span) => {
        try {
          const result = await fn();
          span.end();
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.end();
          throw error;
        }
      },
    );
  } catch {
    // Malformed context or span failure → plain processing (spec).
    return fn();
  }
}
