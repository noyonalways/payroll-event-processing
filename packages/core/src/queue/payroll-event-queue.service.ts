import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PAYROLL_EVENTS_QUEUE, PAYROLL_EVENT_JOB } from '@repo/shared';
import { TRACE_CONTEXT_KEY, traceContextForJob } from '../telemetry/tracing';

export interface PayrollEventJobInput {
  eventId: string;
  /** Tenant the event belongs to — the worker's tenancy boundary. */
  organizationId: string;
  eventType: string;
  employeeId: string;
  /** JSON-safe sequence (Number(bigint)) — job data must be JSON-serializable. */
  sequence: number;
  /**
   * Attempts already recorded for this event before the round this job starts
   * (event-recovery design D4). 0/undefined for a first-round submission; a
   * relay passes the row's `attempt_base` so a manually retried event's fresh
   * job numbers its attempts after the trail instead of over it. The worker
   * adds this ONLY to its own round's counter — never to a job that is
   * continuing its own retry backoff (whose data keeps its original base).
   */
  attemptBase?: number;
}

interface PayrollEventJobData extends PayrollEventJobInput {
  attempt?: number;
}

/**
 * Producer for the `payroll-events` queue.
 *
 * Per-employee FIFO is achieved with `jobId = perEmployeeJobId(organizationId,
 * employeeId)`: BullMQ silently ignores an `add` whose jobId already exists, so at
 * most one job per employee is in flight while different employees run in parallel.
 * The organization is part of the key because employee numbers are tenant-local —
 * two organizations using the same employee number must NOT share a queue slot, or
 * one tenant's backlog would delay the other's. An `add` that is suppressed by an
 * existing job is NOT a lost event: the persisted row (`status` + `sequence`) is
 * the source of truth and the worker's relay recovers it.
 *
 * Retry policy (R1): BullMQ retries transient failures with exponential
 * backoff up to `PAYROLL_MAX_RETRY_ATTEMPTS` attempts. The base delay is
 * `PAYROLL_RETRY_BASE_DELAY_MS`; BullMQ computes each delay as
 * `baseDelay * 2^(attempt-1)`. The worker discriminates transient from
 * permanent errors and re-throws only on transient (design D1).
 */
/**
 * BullMQ job id for per-employee FIFO. Tenant-qualified so two organizations that
 * happen to use the same employee number never share a queue slot.
 *
 * The separator is `|`, NOT `:` — BullMQ rejects a custom id containing a colon
 * unless it splits into exactly three segments (a legacy repeatable-job
 * compatibility check: `Custom Id cannot contain :`). Both parts are
 * percent-encoded, so the separator cannot occur inside either one and the
 * mapping is injective: distinct (organization, employee) pairs can never
 * collapse onto one job id, which would silently suppress a submission.
 */
export function perEmployeeJobId(organizationId: string, employeeId: string): string {
  return `${encodeURIComponent(organizationId)}|${encodeURIComponent(employeeId)}`;
}

@Injectable()
export class PayrollEventQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PayrollEventQueueService.name);
  private readonly maxRetryAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    @InjectQueue(PAYROLL_EVENTS_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {
    this.maxRetryAttempts = this.config.get<number>('PAYROLL_MAX_RETRY_ATTEMPTS', 5);
    this.retryBaseDelayMs = this.config.get<number>('PAYROLL_RETRY_BASE_DELAY_MS', 1000);

    // Surface Redis connection errors through Nest's logger instead of letting
    // ioredis raise unhandled 'error' events (Redis down is an expected state).
    this.queue.on('error', (error: Error) => {
      this.logger.warn(`payroll-events queue connection error: ${error.message}`);
    });
  }

  /**
   * Adds the job for an event. Resolves on success; when the jobId already
   * exists the add is a silent no-op (job is undefined). The caller decides
   * how to treat failures — never let an enqueue error fail the submission.
   *
   * Jobs are configured with exponential backoff (R1): transient failures in
   * the worker re-throw so BullMQ schedules the next attempt at the computed
   * delay; permanent failures are swallowed by the worker (no re-throw).
   */
  async enqueue(input: PayrollEventJobInput): Promise<void> {
    const data: PayrollEventJobData = { ...input };
    // Best-effort trace propagation (observability design D3): an additive
    // optional key on the payload; `null`/absence when tracing is disabled.
    // The injection can NEVER throw here — and R2 still holds: the enqueue's
    // 2 s ceiling and swallow cover everything.
    const traceContext = traceContextForJob();
    // The context rides IN the job data (an additive optional key), never in
    // job opts — BullMQ does not preserve unknown opts keys.
    const payload = (
      traceContext ? { ...data, [TRACE_CONTEXT_KEY]: traceContext } : data
    ) as PayrollEventJobData;
    const job = await this.queue.add(PAYROLL_EVENT_JOB, payload, {
      jobId: perEmployeeJobId(input.organizationId, input.employeeId),
      attempts: this.maxRetryAttempts,
      backoff: { type: 'exponential', delay: this.retryBaseDelayMs },
      // Completed jobs must be freed so the same jobId can be reused by the
      // relay — a retained completed job would suppress the next add and
      // starve the per-employee FIFO (design D5).
      removeOnComplete: true,
      removeOnFail: true,
    });

    this.logger.verbose(
      `Enqueued ${input.eventType} event ${input.eventId} for employee ` +
        `${input.employeeId} in organization ${input.organizationId} (seq ${input.sequence}` +
        `, attemptBase ${input.attemptBase ?? 0})` +
        (job ? ` — job ${job.id}` : ' — suppressed (job already present)'),
    );
  }

  /**
   * Best-effort enqueue with a wall-clock guard. If Redis is unreachable,
   * ioredis's offline queue would otherwise hold the `add` — and thereby the
   * caller's request — indefinitely, so the add is raced against a timeout and
   * treated as a logged, recoverable failure. The event row is authoritative
   * either way: a timed-out command may still land later, but the worker's
   * claim guard (queued → processing) makes a duplicate job a harmless no-op,
   * and the row stays awaited by the relay. Shared by the submission (201 never
   * depends on Redis state) and the manual retry (recovery actions never fail
   * on the queue) — R2's best-effort enqueue discipline.
   */
  async enqueueBestEffort(input: PayrollEventJobInput): Promise<void> {
    try {
      await Promise.race([this.enqueue(input), this.enqueueTimeout()]);
    } catch (error) {
      this.logger.error(
        `Enqueue failed for event ${input.eventId} (${input.eventType}, employee ` +
          `${input.employeeId}, organization ${input.organizationId}, seq ${input.sequence}): ` +
          `${this.errorMessage(error)}`,
      );
    }
  }

  private enqueueTimeout(ms = 2000): Promise<never> {
    return new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for Redis')),
        ms,
      );
      timer.unref();
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
