import { Injectable, Logger, HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma, EventStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { IDEMPOTENCY_SCOPE_EVENT_SUBMISSION } from '../common/idempotency/idempotency.constants';
import { EventType } from './event-type';
import { PayloadValidator } from './payload.validator';
import { EventStatusResponseDto } from './dto/event-status-response.dto';

export interface CreateEventInput {
  eventType: EventType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface SubmissionResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/**
 * Shape returned by a *fresh* submission's op. Replays/races return only the
 * stored { status, body } — no eventId — so post-commit work is skipped for them.
 */
interface FreshSubmission {
  eventId: string;
  status: number;
  body: Record<string, unknown>;
  sequence: bigint;
}

/**
 * Submits payroll events with exactly-once semantics, scoped to ONE organization.
 *
 * The tenant boundary is the first argument of every public method, so no call site
 * can read or write payroll data without naming the organization it belongs to.
 * The organization comes from the verified access token (see `JwtAuthGuard`); it is
 * never accepted from the request body.
 *
 *   1. validate payload per eventType (400 on failure)
 *   2. delegate dedupe + transactional insert to the shared idempotency layer
 *      (`IdempotencyService.execute` under scope `event-submission`): a keyed
 *      replay serves the stored response with no side effects; a miss runs the
 *      insert inside the layer's transaction alongside the idempotency record;
 *      a UNIQUE(organization, scope, key) race is returned as the winner's stored
 *      response
 *   3. post-commit (fresh submissions only): mark the row `received → queued`,
 *      then best-effort enqueue (never blocks or fails the 201; the worker's
 *      relay recovers failures)
 *
 * The DB unique key on idempotency_records — not this code — is the arbiter of
 * idempotency (R2).
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payloadValidator: PayloadValidator,
    private readonly eventQueue: PayrollEventQueueService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async createEvent(
    organizationId: string,
    input: CreateEventInput,
  ): Promise<SubmissionResult> {
    await this.payloadValidator.validate(input.eventType, input.payload);

    // Every supported payload type requires employeeId; payload is validated above.
    const employeeId = input.payload.employeeId as string;

    this.logger.debug(
      `Submitting ${input.eventType} for employee ${employeeId} in organization ` +
        `${organizationId} (key ${input.idempotencyKey})`,
    );

    // The layer dedupes under scope 'event-submission' and persists the stored
    // response in the same transaction as the event row (exactly-once). A replay
    // or race returns only { status, body } — no eventId — so the enqueue path
    // below is skipped for those.
    const submitted = await this.idempotency.execute(
      organizationId,
      IDEMPOTENCY_SCOPE_EVENT_SUBMISSION,
      input.idempotencyKey,
      (tx) => this.insertEvent(tx, input, employeeId, organizationId),
    );

    if (submitted.eventId) {
      this.logger.log(
        `Event ${submitted.eventId} persisted (${input.eventType}, employee ${employeeId}, organization ${organizationId})`,
      );

      // Background the queue so the 201 never depends on Redis state. The row is
      // marked `queued` first (always recoverable), then enqueued best-effort.
      await this.markQueued(organizationId, submitted.eventId, employeeId);
      await this.enqueueBestEffort({
        id: submitted.eventId,
        organizationId,
        eventType: input.eventType,
        employeeId,
        sequence: submitted.sequence,
      });
    }

    return { httpStatus: submitted.status, body: submitted.body };
  }

  /**
   * Read-only status query (event-status-api, design D2/D4), scoped to the caller's
   * organization. Two sequential reads over existing tables: `payroll_events` by
   * (organization, id), then the append-only `event_attempts` audit trail (sorted by
   * attempt number at the boundary).
   *
   * Never mutates anything. An event belonging to ANOTHER organization is reported
   * as 404, not 403: the caller learns nothing about whether the id exists
   * elsewhere. Unknown id → NotFoundException (shaped into the documented 404
   * `ErrorResponseDto` by the global filter).
   */
  async getEventStatus(
    organizationId: string,
    id: string,
  ): Promise<EventStatusResponseDto> {
    // findFirst rather than findUnique: the lookup key is (organization_id, id),
    // and the organization is not the primary key.
    const row = await this.prisma.payrollEvent.findFirst({
      where: { id, organizationId },
    });
    if (!row) {
      throw new NotFoundException(`Event with id ${id} not found`);
    }

    const attempts = await this.prisma.eventAttempt.findMany({
      where: { eventId: id },
      orderBy: { attemptNumber: 'asc' },
    });

    // The DTO contract fixes ascending order at the API boundary, independent
    // of the store's ordering guarantee — one small, robust sort on a short
    // append-only trail.
    attempts.sort((a, b) => a.attemptNumber - b.attemptNumber);

    return {
      id: row.id,
      eventType: row.eventType,
      employeeId: row.employeeId,
      // BigInt is not JSON-serializable — coerce at the API boundary (Number).
      sequence: Number(row.sequence),
      status: row.status.toLowerCase() as EventStatusResponseDto['status'],
      payload: row.payload as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
      result: row.result ? (row.result as Record<string, unknown>) : null,
      attempts: attempts.map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        errorType: attempt.errorType,
        failedReason: attempt.failedReason,
        result: attempt.result ? (attempt.result as Record<string, unknown>) : null,
        createdAt: attempt.createdAt.toISOString(),
      })),
    };
  }

  /**
   * op — runs inside the idempotency layer's transaction. Per-employee advisory
   * lock → MAX(sequence)+1 → insert. The stored response is persisted by the
   * layer in the same commit; no response columns live on the event row anymore.
   */
  private async insertEvent(
    tx: Prisma.TransactionClient,
    input: CreateEventInput,
    employeeId: string,
    organizationId: string,
  ): Promise<FreshSubmission> {
    const id = randomUUID();

    // The advisory-lock key is TENANT-QUALIFIED. Employee numbers are chosen by the
    // customer, so two organizations may legitimately use the same one; keying the
    // lock on the bare employee id would make unrelated tenants serialize on each
    // other's submissions.
    const sequenceLockKey = `${organizationId}:${employeeId}`;

    // Serialize inserts for one employee WITHIN one organization so MAX(sequence)+1
    // is race-free (R6). $executeRaw (not $queryRaw): pg_advisory_xact_lock returns
    // Postgres `void`, which Prisma's queryRaw result deserializer cannot map.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sequenceLockKey}))`;

    const rows = await tx.$queryRaw<Array<{ max: bigint | null }>>`
      SELECT COALESCE(MAX(sequence), 0) AS max
      FROM "payroll_events"
      WHERE organization_id = ${organizationId}
        AND employee_id = ${employeeId}`;
    const next = (rows[0]?.max ?? 0n) + 1n;

    await tx.payrollEvent.create({
      data: {
        id,
        organizationId,
        eventType: input.eventType,
        employeeId,
        payload: input.payload as Prisma.InputJsonValue,
        sequence: next,
        idempotencyKey: input.idempotencyKey,
        status: EventStatus.RECEIVED,
      },
    });

    return {
      eventId: id,
      status: HttpStatus.CREATED,
      body: { id, status: 'received' },
      sequence: next,
    };
  }

  /**
   * Marks the row `received → queued` (guarded, idempotent — a relay may have
   * already queued it). Failures are logged and never propagated: a submission
   * that cannot be marked queued still returns 201 and is recovered later.
   */
  private async markQueued(
    organizationId: string,
    id: string,
    employeeId: string,
  ): Promise<void> {
    try {
      const { count } = await this.prisma.payrollEvent.updateMany({
        where: { id, organizationId, status: EventStatus.RECEIVED },
        data: { status: EventStatus.QUEUED },
      });
      if (count === 0) {
        this.logger.debug(`Event ${id} already queued — no transition needed`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to mark event ${id} queued for employee ${employeeId}: ${this.errorMessage(error)}`,
      );
    }
  }

  /**
   * Best-effort enqueue with a wall-clock guard. If Redis is unreachable,
   * ioredis's offline queue would otherwise hold the `add` — and thereby the
   * HTTP response — indefinitely, so the add is raced against a timeout and
   * treated as a logged, recoverable failure. The event row is authoritative
   * either way: a timed-out command may still land later, but the worker's
   * claim guard (queued → processing) makes a duplicate job a harmless no-op.
   */
  private async enqueueBestEffort(input: {
    id: string;
    organizationId: string;
    eventType: EventType;
    employeeId: string;
    sequence: bigint;
  }): Promise<void> {
    try {
      await Promise.race([
        this.eventQueue.enqueue({
          eventId: input.id,
          organizationId: input.organizationId,
          eventType: input.eventType,
          employeeId: input.employeeId,
          sequence: Number(input.sequence),
        }),
        this.enqueueTimeout(),
      ]);
    } catch (error) {
      this.logger.error(
        `Enqueue failed for event ${input.id} (${input.eventType}, employee ${input.employeeId}, organization ${input.organizationId}, seq ${input.sequence}): ${this.errorMessage(error)}`,
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
}