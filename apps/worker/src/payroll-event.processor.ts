import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EventStatus, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  PayrollEventQueueService,
  PayrollEventJobInput,
} from '../../../src/queue/payroll-event-queue.service';
import {
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENT_JOB,
} from '../../../src/queue/queue.constants';
import { HandlerRegistry } from '../../../src/processing/handler-registry';
import { ProcessingResult } from '../../../src/processing/processing.types';
import { EventType } from '../../../src/events/event-type';
import { TransientPayrollFailureError } from '../../../src/processing/errors/payroll-processing.error';

/**
 * Consumes `payroll-events` jobs and drives the event lifecycle:
 *
 *   claimed  → queued → processing → success (+ processed_at)
 *
 * - The claim is a guarded `queued → processing` update: a job whose row is not
 *   in `queued` state is stale/duplicate and skipped with no side effects — this
 *   already prevents a crash-then-reprocess from applying success twice (R5
 *   scaffold). Full row locks + exactly-once commit land in #7.
 * - Between claim and terminal the worker dispatches to the per-type handler
 *   strategy registry (`src/processing`): on success the handler's result is
 *   stored with the guarded `processing → success`; on simulated failure the
 *   row transitions to `failed` (transient vs permanent retry strategy lands
 *   in #5 — here both classes are terminal).
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
  private readonly maxRetryAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: PayrollEventQueueService,
    private readonly registry: HandlerRegistry,
    private readonly config: ConfigService,
  ) {
    super();
    this.maxRetryAttempts = this.config.get<number>('PAYROLL_MAX_RETRY_ATTEMPTS', 5);
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

  /**
   * Fires when BullMQ marks a job as failed (after every failed attempt,
   * including mid-retry ones). Only acts when all attempts are exhausted
   * (D4): writes the event row to `failed` to sync DB state with BullMQ.
   *
   * Mid-retry calls (attemptsMade < maxAttempts) are pure no-ops — the
   * row was already reset to `queued` in `process()` before re-throwing.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<PayrollEventJobInput>, error: Error): Promise<void> {
    if (job.name !== PAYROLL_EVENT_JOB) {
      return;
    }

    const maxAttempts = job.opts?.attempts ?? this.maxRetryAttempts;
    if (job.attemptsMade < maxAttempts) {
      // Mid-retry: the row is already in `queued` (reset in process()). No-op.
      return;
    }

    // All attempts exhausted — write terminal `failed` (R1, D4).
    const { eventId, employeeId, eventType, sequence } = job.data;
    await this.prisma.payrollEvent.updateMany({
      where: { id: eventId, status: EventStatus.QUEUED },
      data: { status: EventStatus.FAILED },
    });
    this.logger.error(
      `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
        `(seq ${sequence}, attempts exhausted after ${job.attemptsMade}, worker ${this.workerPid}) — exhausted: ${error.message}`,
    );
  }

  async process(job: Job<PayrollEventJobInput>): Promise<void> {
    const { eventId, employeeId, eventType, sequence } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

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

    // 2. Read the event payload (the job data deliberately carries identity
    //    only, not the body — the DB row stays the source of truth).
    const row = await this.prisma.payrollEvent.findUnique({
      where: { id: eventId },
      select: { payload: true },
    });
    if (!row) {
      this.logger.warn(`Event row ${eventId} not found — skipping job`);
      return;
    }

    // 3. Dispatch to the handler for this event type (strategy registry).
    const strategy = this.registry.resolve(eventType);
    this.logger.log(
      `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
        `(seq ${sequence}, attempt ${attempt}, worker ${this.workerPid}) — started`,
    );

    let result: ProcessingResult;
    try {
      result = await strategy.handle({
        eventId,
        eventType: eventType as EventType,
        employeeId,
        sequence,
        payload: row.payload as Record<string, unknown>,
        attempt,
      });
    } catch (error) {
      if (error instanceof TransientPayrollFailureError) {
        // Transient failure (R1, D1): reset the row so the claim guard succeeds
        // on BullMQ's next attempt (D2), then re-throw so BullMQ schedules
        // the retry with exponential backoff (D3). Do NOT write `failed` here.
        await this.prisma.payrollEvent.updateMany({
          where: { id: eventId, status: EventStatus.PROCESSING },
          data: { status: EventStatus.QUEUED },
        });
        this.logger.warn(
          `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
            `(seq ${sequence}, attempt ${attempt}/${this.maxRetryAttempts}, worker ${this.workerPid}) — retrying: ${this.errorMessage(error)}`,
        );
        throw error; // signals BullMQ to schedule the next attempt
      }

      // Permanent or unknown failure (R1, D1): write terminal `failed` and
      // return normally — do NOT re-throw (no further BullMQ attempts).
      await this.prisma.payrollEvent.updateMany({
        where: { id: eventId, status: EventStatus.PROCESSING },
        data: { status: EventStatus.FAILED },
      });
      this.logger.error(
        `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
          `(seq ${sequence}, attempt ${attempt}, worker ${this.workerPid}) — permanent-failure: ${this.errorMessage(error)}`,
      );
      return;
    }

    // 4. Terminal success — result + processed_at written together in the same
    //    guarded update, so a crash-then-reprocess can never apply the change
    //    twice or double-write a result (R5).
    await this.prisma.payrollEvent.updateMany({
      where: { id: eventId, status: EventStatus.PROCESSING },
      data: {
        status: EventStatus.SUCCESS,
        processedAt: new Date(),
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
    this.logger.log(
      `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
        `(seq ${sequence}, attempt ${attempt}, worker ${this.workerPid}) — succeeded (reference ${result.reference})`,
    );
    // 5. FIFO continuation: NOT here (the current job is still active, so an
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