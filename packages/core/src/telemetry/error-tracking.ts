import { Logger } from '@nestjs/common';

/**
 * Error tracking (observability design D4) — Sentry via `@sentry/nestjs`
 * (API) / `@sentry/node` (worker), disabled entirely unless `SENTRY_DSN` is
 * configured. Every capture is fail-soft: a tracker outage can never alter a
 * response or a processing outcome.
 *
 * PII posture (spec): passwords, tokens, credentials, and user emails are
 * stripped in `beforeSend`; identifiers (eventId, organizationId) travel as
 * tags only, so they are searchable without becoming payload content.
 */
const logger = new Logger('TelemetryErrorTracking');

/** Field names scrubbed from any captured payload. */
const SCRUB_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'credential',
  'signingSecret',
  'secret',
  'authorization',
  'refreshToken',
  'accessToken',
  'token',
  'email',
]);

export interface ErrorTracker {
  captureException(error: unknown, context?: Record<string, unknown>): void;
}

const passthroughTracker: ErrorTracker = {
  captureException: () => undefined,
};

let active: ErrorTracker = passthroughTracker;

/** True once a DSN was configured and init succeeded. */
export function isTrackingEnabled(): boolean {
  return active !== passthroughTracker;
}

export async function initErrorTracking(processName: 'api' | 'worker'): Promise<void> {
  if (!process.env.SENTRY_DSN) {
    logger.log(`Error tracking disabled (no SENTRY_DSN) — ${processName}`);
    return;
  }
  try {
    const Sentry = await import(
      processName === 'api' ? '@sentry/nestjs' : '@sentry/node'
    );

    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: process.env.GIT_SHA,
      environment: process.env.NODE_ENV ?? 'development',
      sendDefaultPii: false,
      // `any` here: the union of @sentry/nestjs|node event types resolves to
      // any under the dynamic import; the scrubber only reads JSON fields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      beforeSend(event: any) {
        // Scrub secrets/PII from EVERY outbound payload before it leaves the
        // process (spec: passwords, tokens, credentials, emails absent).
        const scrubbed = JSON.stringify(
          event,
          (key, value) => (SCRUB_KEYS.has(key) ? '[redacted]' : value),
        );
        return JSON.parse(scrubbed) as typeof event;
      },
    });

    active = {
      captureException(error, context) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Sentry.withScope((scope: any) => {
            for (const [tag, value] of Object.entries(context ?? {})) {
              // Identifiers as TAGS (bounded, searchable) — never as payload.
              scope.setTag(tag, String(value));
            }
            Sentry.captureException(error);
          });
        } catch {
          // Tracker unavailability never alters the caller.
        }
      },
    };
    logger.log(`Sentry error tracking enabled — ${processName}`);
  } catch (error) {
    // A broken tracker setup is a logging concern, never a boot failure.
    logger.error(
      `Error tracking setup failed (continuing untracked): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The process-wide capture entrypoint — ALWAYS safe to call, whether or not
 * tracking is enabled. 4xx client errors are explicitly NOT incidents; the
 * API filter only forwards 5xx/unhandled.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  active.captureException(error, context);
}
