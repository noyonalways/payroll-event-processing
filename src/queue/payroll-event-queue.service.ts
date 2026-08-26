import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PAYROLL_EVENTS_QUEUE, PAYROLL_EVENT_JOB } from './queue.constants';

export interface PayrollEventJobInput {
  eventId: string;
  eventType: string;
  employeeId: string;
  /** JSON-safe sequence (Number(bigint)) — job data must be JSON-serializable. */
  sequence: number;
}

interface PayrollEventJobData extends PayrollEventJobInput {
  attempt?: number;
}

/**
 * Producer for the `payroll-events` queue.
 *
 * Per-employee FIFO is achieved with `jobId = employeeId`: BullMQ silently
 * ignores an `add` whose jobId already exists, so at most one job per employee
 * is in flight while different employees run in parallel. An `add` that is
 * suppressed by an existing job is NOT a lost event — the persisted row
 * (`status` + `sequence`) is the source of truth and the worker's relay
 * recovers it.
 *
 * Retry policy (R1): BullMQ retries transient failures with exponential
 * backoff up to `PAYROLL_MAX_RETRY_ATTEMPTS` attempts. The base delay is
 * `PAYROLL_RETRY_BASE_DELAY_MS`; BullMQ computes each delay as
 * `baseDelay * 2^(attempt-1)`. The worker discriminates transient from
 * permanent errors and re-throws only on transient (design D1).
 */
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
    const job = await this.queue.add(PAYROLL_EVENT_JOB, data, {
      jobId: input.employeeId,
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
        `${input.employeeId} (seq ${input.sequence})` +
        (job ? ` — job ${job.id}` : ' — suppressed (job already present)'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
