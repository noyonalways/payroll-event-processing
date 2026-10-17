import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { PrismaService } from '@repo/database';
import { EventType } from '@repo/shared';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { EventStatusPublisher } from './event-status.publisher';
import { WebhookOutboxWriter } from '../webhooks/webhook-outbox.writer';
import { MetricsService } from '../telemetry/metrics.service';
import { EventActionResponseDto } from './dto/event-action-response.dto';

/**
 * Manual lifecycle recovery over organization-scoped payroll events
 * (event-recovery design D2): `retryEvent` puts a terminal `failed` event back
 * on its per-employee chain, `cancelEvent` stops a pending one.
 *
 * The tenant boundary is the first argument of every public method — the same
 * convention as `EventsService` — and the organization comes from the verified
 * access token. An event of another organization reads as 404, identical to an
 * unknown id.
 *
 * Every action is ONE guarded transaction (R5's transition model): the
 * `updateMany` WHERE clause is the only authority on whether the transition
 * applies, so concurrent actions compose safely — the loser matches 0 rows,
 * throws 409, and its whole transaction (including its audit row) rolls back.
 * The audit row (design D6) is created INSIDE that transaction, so an audit
 * row exists exactly when the action happened. Rejected calls record nothing.
 *
 * Both actions are best-effort on the QUEUE, never on the row: the guarded
 * transition commits first, then the enqueue rides the shared wall-clock
 * helper (R2). A retry whose enqueue lands nowhere is still `queued` and is
 * picked up by the employee's relay — the same recovery story as a submission.
 * A cancel never touches the queue at all: the guarded claim makes any job
 * that later surfaces for a cancelled row a harmless no-op, and its completion
 * relay keeps the employee's chain draining (design D5).
 */
@Injectable()
export class EventRecoveryService {
  private readonly logger = new Logger(EventRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventQueue: PayrollEventQueueService,
    private readonly streamPublisher: EventStatusPublisher,
    private readonly webhookOutbox: WebhookOutboxWriter,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Puts a terminal `failed` event back to work: one transaction that
   * (1) reads MAX(attempt_number) — served by the UNIQUE (event_id,
   * attempt_number) index over the event's short trail, (2) runs the guarded
   * `failed → queued` transition with `attempt_base` set to that max (design
   * D4: the fresh round's numbering continues the trail), and (3) appends the
   * RETRY audit row. After the commit the enqueue is best-effort.
   */
  async retryEvent(
    organizationId: string,
    id: string,
    actorId: string,
  ): Promise<EventActionResponseDto> {
    const row = await this.prisma.payrollEvent.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        eventType: true,
        employeeId: true,
        sequence: true,
        status: true,
      },
    });
    if (!row) {
      throw new NotFoundException(`Event with id ${id} not found`);
    }
    if (row.status !== EventStatus.FAILED) {
      this.logger.warn(
        `Retry rejected for event ${id} (employee ${row.employeeId}, organization ${organizationId}): status is ${row.status}, only FAILED events can be retried`,
      );
      throw new ConflictException(
        `Event ${id} is ${row.status.toLowerCase()} — only failed events can be retried`,
      );
    }

    const attemptBase = await this.prisma.$transaction(async (tx) => {
      const trail = await tx.eventAttempt.aggregate({
        _max: { attemptNumber: true },
        where: { eventId: id },
      });
      const base = trail._max.attemptNumber ?? 0;

      const { count } = await tx.payrollEvent.updateMany({
        where: { id, organizationId, status: EventStatus.FAILED },
        data: { status: EventStatus.QUEUED, attemptBase: base },
      });
      if (count === 0) {
        // A concurrent action left this transaction and its audit row with
        // nothing to apply.
        throw new ConflictException(
          `Event ${id} is no longer failed — it was retried or cancelled concurrently`,
        );
      }
      await tx.eventAction.create({
        data: { eventId: id, action: 'RETRY', userId: actorId },
      });
      return base;
    });

    // Post-commit stream announcement (realtime-status design D3): the guarded
    // `failed → queued` transition has committed — announce `queued`
    // fire-and-forget (a stream failure can never reach the already-committed
    // action, R2), then best-effort enqueue the fresh job.
    this.streamPublisher.publish({
      organizationId,
      eventId: id,
      // The stored column is a plain string; every persisted value is a
      // registry-supported event type (the payload validator enforces it), so
      // the notification wire type reclaims the enum at the boundary.
      eventType: row.eventType as EventType,
      employeeId: row.employeeId,
      sequence: Number(row.sequence),
      status: 'queued',
      occurredAt: new Date().toISOString(),
    });

    // Best-effort, POST-commit (R2): the row is `queued` either way; a timed-out
    // or suppressed add is recovered by the employee's relay. attemptBase rides
    // the fresh job when the add lands (D4); the relay path re-reads the row.
    // The helper swallows internally — this catch is the belt-and-braces that
    // keeps any queue-side behavior from failing an ALREADY-COMMITTED action.
    try {
      await this.eventQueue.enqueueBestEffort({
        eventId: id,
        organizationId,
        eventType: row.eventType,
        employeeId: row.employeeId,
        sequence: Number(row.sequence),
        attemptBase,
      });
    } catch (error) {
      this.logger.error(
        `Post-commit enqueue failed for retried event ${id} (${row.eventType}, employee ` +
          `${row.employeeId}, organization ${organizationId}): ${this.errorMessage(error)}`,
      );
    }

    this.logger.log(
      `Retry applied to ${row.eventType} event ${id} for employee ${row.employeeId} ` +
        `in organization ${organizationId} (seq ${Number(row.sequence)}, round base ${attemptBase}, actor ${actorId}) — queued`,
    );

    return {
      id,
      status: 'queued',
      eventType: row.eventType,
      employeeId: row.employeeId,
    };
  }

  /**
   * Stops a pending event: one transaction that runs the guarded
   * `received|queued → cancelled` transition and appends the CANCEL audit row.
   * The cancel records NO processing attempt (none ran), does not touch the
   * queue, and is terminal — only `failed` was ever retryable.
   */
  async cancelEvent(
    organizationId: string,
    id: string,
    actorId: string,
  ): Promise<EventActionResponseDto> {    const row = await this.prisma.payrollEvent.findFirst({
      where: { id, organizationId },
      select: { id: true, eventType: true, employeeId: true, sequence: true, status: true },
    });
    if (!row) {
      throw new NotFoundException(`Event with id ${id} not found`);
    }
    if (row.status !== EventStatus.RECEIVED && row.status !== EventStatus.QUEUED) {
      this.logger.warn(
        `Cancel rejected for event ${id} (employee ${row.employeeId}, organization ${organizationId}): status is ${row.status}, only pending (received/queued) events can be cancelled`,
      );
      throw new ConflictException(
        `Event ${id} is ${row.status.toLowerCase()} — only pending events can be cancelled`,
      );
    }

    const cancelledAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollEvent.updateMany({
        where: {
          id,
          organizationId,
          status: { in: [EventStatus.RECEIVED, EventStatus.QUEUED] },
        },
        data: { status: EventStatus.CANCELLED },
      });
      if (count === 0) {
        throw new ConflictException(
          `Event ${id} is no longer pending — it was claimed or cancelled concurrently`,
        );
      }
      await tx.eventAction.create({
        data: { eventId: id, action: 'CANCEL', userId: actorId },
      });
      // Cancel is a TERMINAL state, so its webhook delivery intents commit in
      // the same transaction (integrator-webhooks: every terminal transition
      // produces its intent). CANCELLED notifications carry neither result nor
      // failure reason.
      await this.webhookOutbox.write(tx, {
        eventId: id,
        organizationId,
        employeeId: row.employeeId,
        eventType: row.eventType,
        sequence: Number(row.sequence),
        status: 'CANCELLED',
        occurredAt: cancelledAt.toISOString(),
      });
      this.metrics.recordTerminal(row.eventType, 'CANCELLED');
    });

    // Post-commit stream announcement (realtime-status design D3): the guarded
    // transition to the terminal `cancelled` state has committed. Cancel never
    // touches the queue, so this is the only announcement the action emits.
    this.streamPublisher.publish({
      organizationId,
      eventId: id,
      eventType: row.eventType as EventType,
      employeeId: row.employeeId,
      sequence: Number(row.sequence),
      status: 'cancelled',
      occurredAt: new Date().toISOString(),
    });

    this.logger.log(
      `Cancel applied to ${row.eventType} event ${id} for employee ${row.employeeId} ` +
        `in organization ${organizationId} (actor ${actorId}) — cancelled`,
    );

    return {
      id,
      status: 'cancelled',
      eventType: row.eventType,
      employeeId: row.employeeId,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
