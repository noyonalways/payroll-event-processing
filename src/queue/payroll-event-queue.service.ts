import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
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
 */
@Injectable()
export class PayrollEventQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PayrollEventQueueService.name);

  constructor(@InjectQueue(PAYROLL_EVENTS_QUEUE) private readonly queue: Queue) {
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
   */
  async enqueue(input: PayrollEventJobInput): Promise<void> {
    const data: PayrollEventJobData = { ...input };
    const job = await this.queue.add(PAYROLL_EVENT_JOB, data, {
      jobId: input.employeeId,
      attempts: 1, // retry/backoff lands in retry-and-failure-strategy (#5)
      // Completed jobs must be freed so the same jobId can be reused by the
      // relay — a retained completed job would suppress the next add and
      // starve the per-employee FIFO (design D5).
      removeOnComplete: true,
      removeOnFail: true,
    });

    this.logger.debug(
      `Enqueued ${input.eventType} event ${input.eventId} for employee ` +
        `${input.employeeId} (seq ${input.sequence})` +
        (job ? ` — job ${job.id}` : ' — suppressed (job already present)'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}