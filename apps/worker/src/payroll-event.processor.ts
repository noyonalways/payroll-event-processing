import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EventStatus } from '@prisma/client';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  PayrollEventQueueService,
  PayrollEventJobInput,
} from '../../../src/queue/payroll-event-queue.service';
import {
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENT_JOB,
} from '../../../src/queue/queue.constants';

/**
 * Consumes `payroll-events` jobs and drives the event lifecycle:
 *
 *   claimed  → queued → processing → success (+ processed_at)
 *
 * - The claim is a guarded `queued → processing` update: a job whose row is not
 *   in `queued` state is stale/duplicate and skipped with no side effects — this
 *   already prevents a crash-then-reprocess from applying success twice (R5
 *   scaffold). Full row locks + exactly-once commit land in #7.
 * - The terminal `processing → success` with the status guard is scaffolding:
 *   the simulated provider call and attempt history (#4/#5) will sit between
 *   claim and terminal.
 * - FIFO continuation happens on the BullMQ `completed` event, NOT at the end of
 *   `process()`: while `process()` runs the current job is still ACTIVE, so an
 *   `add` with the same `jobId = employeeId` would be suppressed by its own key.
 *   BullMQ moves the job to completed (freeing the key via `removeOnComplete`)
 *   and only then emits `completed`, so a relay driven from that event actually
 *   lands (design D2's Postgres-driven drain).
 * - After the employee's job completes the worker RELAYS the next pending event
 *   (`status IN (received, queued)`, `sequence ASC`) — `jobId = employeeId`
 *   suppress or land, never a duplicate. This recovers events whose producer add
 *   was suppressed while this job was in flight.
 *
 * Note on lifecycle: `WorkerHost.worker` is only populated by the BullRegistrar
 * during Nest's `onModuleInit` phase, so nothing here may touch `this.worker` at
 * construction time — in direct-instantiation unit tests the Worker never exists.
 * Event wiring therefore uses the `@OnWorkerEvent` decorators (registered by the
 * explorer after `_worker` is attached), and `onModuleDestroy` guards the
 * potentially-uninitialized case.
 */
@Processor(PAYROLL_EVENTS_QUEUE)
@Injectable()
export class PayrollEventProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(PayrollEventProcessor.name);
  private readonly workerPid = process.pid;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: PayrollEventQueueService,
  ) {
    super();
  }

  /**
   * Connected by the Bull explorer to `worker.on('error', …)` once the worker is
   * created — surfaces Redis connection drops via Nest's logger instead of an
   * unhandled 'error' event.
   */
  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.warn(`Worker connection error: ${error.message}`);
  }

  /**
   * Connected by the explorer to `worker.on('completed', …)` — fires AFTER the
   * job was moved to completed and (via `removeOnComplete: true`) its jobId key
   * freed, so the relay's `add` with `jobId = employeeId` actually lands. This is
   * what lets one employee's queued burst drain one-at-a-time in sequence order
   * despite producer adds being suppressed while a job is in flight (design D2).
   */
  @OnWorkerEvent('completed')
  async onCompleted(job: Job<PayrollEventJobInput>): Promise<void> {
    if (job.name !== PAYROLL_EVENT_JOB) {
      return;
    }
    await this.relayNextPending(job.data.employeeId, job.data.eventId);
  }

  async process(job: Job<PayrollEventJobInput>): Promise<void> {
    const { eventId, employeeId, eventType, sequence } = job.data;

    // 1. Claim — a relayed job may still find the row `received`; ensure queued
    //    (no-op when the producer already flipped it), then claim processing.
    await this.prisma.payrollEvent.updateMany({
      where: { id: eventId, status: EventStatus.RECEIVED },
      data: { status: EventStatus.QUEUED },
    });

    const claimed = await this.prisma.payrollEvent.updateMany({
      where: { id: eventId, status: EventStatus.QUEUED },
      data: { status: EventStatus.PROCESSING },
    });

    if (claimed.count === 0) {
      // Stale/duplicate job: the row is already processing, success, or failed.
      // Never reprocess — the success write is guarded, so a crash-then-reprocess
      // cannot double-apply (R5).
      this.logger.warn(
        `Skipping stale/duplicate job for event ${eventId} (row is not 'queued')`,
      );
      return;
    }

    // 2. The processing step for this change IS the structured log below; the
    //    simulated provider call + attempt recording land in #4.
    this.logger.log(
      `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
        `(seq ${sequence}, attempt 1, worker ${this.workerPid})`,
    );

    // 3. Terminal state (guarded — only a row in processing may succeed).
    await this.prisma.payrollEvent.updateMany({
      where: { id: eventId, status: EventStatus.PROCESSING },
      data: { status: EventStatus.SUCCESS, processedAt: new Date() },
    });
    // 4. FIFO continuation: NOT here (the current job is still active, so an
    //    `add` with the same jobId would self-suppress). The `completed` event
    //    handler relays the next pending event once the jobId key is freed.
  }

  /**
   * Re-schedules the next event for the employee after this job completes.
   * Querying the DB (the source of truth) with `status IN (received, queued)`
   * ordered by `sequence` means a relay picks up even events whose submission
   * `add` was suppressed while a job was in flight. The `add` uses
   * `jobId = employeeId`, so one land wins and concurrent relays are no-ops.
   */
  private async relayNextPending(
    employeeId: string,
    currentEventId: string,
  ): Promise<void> {
    try {
      const next = await this.prisma.payrollEvent.findFirst({
        where: {
          employeeId,
          id: { not: currentEventId },
          status: { in: [EventStatus.RECEIVED, EventStatus.QUEUED] },
        },
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          eventType: true,
          employeeId: true,
          sequence: true,
        },
      });

      if (!next) {
        return;
      }

      this.logger.debug(
        `Relaying next ${next.eventType} event ${next.id} (seq ${next.sequence}) for employee ${employeeId}`,
      );

      await this.queueService.enqueue({
        eventId: next.id,
        eventType: next.eventType,
        employeeId: next.employeeId,
        sequence: Number(next.sequence),
      });
    } catch (error) {
      // A failed relay must never fail the current job: the row stays
      // pending in Postgres and the employee's next job retries the relay.
      this.logger.error(
        `Relay failed for employee ${employeeId} after event ${currentEventId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker.close();
    } catch (error) {
      // Only reachable in unit isolation (no Nest bootstrap) where the worker
      // was never created; the BullRegistrar already closes it in production.
      this.logger.warn(
        `Worker not initialized on shutdown; nothing to close (${this.errorMessage(error)})`,
      );
    }
  }
}