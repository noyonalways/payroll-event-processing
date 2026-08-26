import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EventStatus, AttemptStatus, AttemptErrorType } from '@prisma/client';
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
import { WORKER_OPTIONS } from '../../../src/queue/worker-options';
import { EventClaim } from '../../../src/processing/event-claim';
import { HeartbeatService } from '../../../src/processing/heartbeat.service';
import { TransientPayrollFailureError } from '../../../src/processing/errors/payroll-processing.error';

/**
 * Consumes `payroll-events` jobs and drives the event lifecycle:
 *
 *   received → queued → processing → success (+ processed_at) | failed
 *
 * The claim → dispatch → terminal-write lifecycle delegates to the
 * transactional `EventClaim` (#7, design D1): a single interactive Postgres
 * transaction takes the `SELECT … FOR UPDATE` row lock, runs the guarded
 * `queued → processing` claim, dispatches the per-type handler, and commits
 * the terminal transition together with the `event_attempts` row (R5).
 *
 * - A transient handler failure RE-THROWS inside the transaction, so it ABORTS
 *   and the claim rolls back to `queued` — there is NO explicit
 *   `processing → queued` reset (a crash at any point before commit likewise
 *   leaves the row claimable; R4).
 * - A permanent handler failure commits `processing → failed` + the
 *   FAILED(PERMANENT) attempt row atomically; a success commits
 *   `processing → success` + `processed_at`/`result` + the SUCCESS attempt row
 *   atomically. Either way the row can only be claimed once (R3), so the heap
 *   handler applied exactly once per event (R5).
 * - A job whose row is not `queued` any more (already processing/success/
 *   failed) is skipped with no side effects.
 *
 * FIFO continuation happens on the BullMQ `completed` event, NOT at the end of
 * `process()`: while `process()` runs the current job is still ACTIVE, so an
 * `add` with the same `jobId = employeeId` would be suppressed by its own key.
 * BullMQ moves the job to completed (freeing the key via `removeOnComplete`)
 * and only then emits `completed`, so a relay driven from that event actually
 * lands (design D2's Postgres-driven drain).
 *
 * Note on lifecycle: `WorkerHost.worker` is only populated by the BullRegistrar
 * during Nest's `onModuleInit` phase, so nothing here may touch `this.worker` at
 * construction time — in direct-instantiation unit tests the Worker never exists.
 * Event wiring therefore uses the `@OnWorkerEvent` decorators (registered by the
 * explorer after `_worker` is attached), and `onModuleDestroy` guards the
 * potentially-uninitialized case.
 */
@Processor(PAYROLL_EVENTS_QUEUE, WORKER_OPTIONS)
@Injectable()
export class PayrollEventProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(PayrollEventProcessor.name);
  private readonly workerPid = process.pid;
  private readonly maxRetryAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: PayrollEventQueueService,
    private readonly config: ConfigService,
    private readonly eventClaim: EventClaim,
    private readonly heartbeat: HeartbeatService,
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
   * including mid-retry ones). Only acts when all attempts are exhausted (D4):
   * writes the event row to `failed` and the FAILED(TEMPORARY) `event_attempts`
   * row together (R5) so the DB state and the audit trail stay in sync.
   *
   * Mid-retry calls (attemptsMade < maxAttempts) are pure no-ops — the claim
   * transaction abort already rolled the row back to `queued`.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<PayrollEventJobInput>, error: Error): Promise<void> {
    if (job.name !== PAYROLL_EVENT_JOB) {
      return;
    }

    const maxAttempts = job.opts?.attempts ?? this.maxRetryAttempts;
    if (job.attemptsMade < maxAttempts) {
      // Mid-retry: the aborted claim transaction already left the row in
      // `queued` — nothing to write. No-op.
      return;
    }

    // All attempts exhausted — terminal `failed` + the audit row in one
    // transaction (R5): the attempt number recorded is the FINAL one (BullMQ's
    // `attemptsMade` is the 0-based count of attempts that ran = last attempt).
    const { eventId, employeeId, eventType, sequence } = job.data;
    await this.prisma.$transaction([
      this.prisma.payrollEvent.updateMany({
        where: { id: eventId, status: EventStatus.QUEUED },
        data: { status: EventStatus.FAILED },
      }),
      this.prisma.eventAttempt.create({
        data: {
          eventId,
          attemptNumber: job.attemptsMade,
          status: AttemptStatus.FAILED,
          errorType: AttemptErrorType.TEMPORARY,
          failedReason: error.message,
        },
      }),
    ]);
    this.logger.error(
      `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
        `(seq ${sequence}, attempts exhausted after ${job.attemptsMade}, worker ${this.workerPid}) — exhausted: ${error.message}`,
    );
  }

  async process(job: Job<PayrollEventJobInput>): Promise<void> {
    const { eventId, employeeId, eventType, sequence } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

    // 1. Ensure `queued` — a relayed job may still find the row `received`;
    //    this flips it to queued before the claim (no-op when the producer
    //    already did). Stays OUTSIDE the claim transaction: it is a
    //    pre-queuing make-safe, not part of the guarded lifecycle.
    await this.prisma.payrollEvent.updateMany({
      where: { id: eventId, status: EventStatus.RECEIVED },
      data: { status: EventStatus.QUEUED },
    });

    // 2. Worker liveness (design D4): bump before dispatch so /health sees the
    //    worker fresh even on slow processing runs between the periodic ticks.
    await this.heartbeat.touch();

    this.logger.log(
      `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
        `(seq ${sequence}, attempt ${attempt}, worker ${this.workerPid}) — started`,
    );

    // 3. Transactional claim → dispatch → terminal write (EventClaim, D1). The
    //    outcome carries the source of each structured log line.
    try {
      const outcome = await this.eventClaim.claimAndProcess({
        eventId,
        eventType,
        employeeId,
        sequence,
        attempt,
      });

      switch (outcome.outcome) {
        case 'skipped':
          // Stale/duplicate job: the row is already processing, success, or
          // failed. Never reprocess — the terminal write is guarded (R5).
          this.logger.warn(
            `Skipping stale/duplicate job for event ${eventId} (row is not 'queued')`,
          );
          return;
        case 'permanent-failure':
          this.logger.error(
            `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
              `(seq ${sequence}, attempt ${attempt}, worker ${this.workerPid}) — permanent-failure: ${outcome.reason}`,
          );
          return;
        case 'success':
          this.logger.log(
            `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
              `(seq ${sequence}, attempt ${attempt}, worker ${this.workerPid}) — succeeded (reference ${outcome.reference})`,
          );
          return;
      }
    } catch (error) {
      if (error instanceof TransientPayrollFailureError) {
        // Transient failure (R1): claimAndProcess re-threw, so the transaction
        // ABORTED and the claim rolled back to `queued` — there is no explicit
        // reset write. Re-throw so BullMQ schedules the retry (D3).
        this.logger.warn(
          `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
            `(seq ${sequence}, attempt ${attempt}/${this.maxRetryAttempts}, worker ${this.workerPid}) — retrying: ${this.errorMessage(error)}`,
        );
        throw error;
      }

      // Infrastructure / unexpected error (e.g. DB connection, unregistered
      // event type): not a business verdict. The abort left the row claimable
      // in `queued`; BullMQ retries, and exhaustion surfaces to onFailed.
      this.logger.error(
        `Processing ${eventType} event ${eventId} for employee ${employeeId} ` +
          `(seq ${sequence}, attempt ${attempt}, worker ${this.workerPid}) — retrying (infrastructure): ${this.errorMessage(error)}`,
      );
      throw error;
    }
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

      this.logger.verbose(
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