import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { Prisma, EventStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { EventType } from './event-type';
import { PayloadValidator } from './payload.validator';

export interface CreateEventInput {
  eventType: EventType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface SubmissionResult {
  httpStatus: HttpStatus;
  body: Record<string, unknown>;
}

/**
 * Submits payroll events with exactly-once semantics:
 *
 *   1. validate payload per eventType (400 on failure)
 *   2. fast-path dedupe on idempotency_key (returns stored response, no side effects)
 *   3. transactional insert: per-employee advisory lock → next sequence → insert,
 *      writing response_status/response_body in the same transaction (design D2/D3/D5)
 *   4. a UNIQUE(idempotency_key) violation (concurrent duplicate) is caught and
 *      turned into a stored-response read — never an error
 *   5. post-commit: mark the row `received → queued`, then best-effort enqueue
 *      (never blocks or fails the 201; the worker's relay recovers failures)
 *
 * The DB unique key — not this code — is the arbiter of idempotency (R2).
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payloadValidator: PayloadValidator,
    private readonly eventQueue: PayrollEventQueueService,
  ) {}

  async createEvent(input: CreateEventInput): Promise<SubmissionResult> {
    await this.payloadValidator.validate(input.eventType, input.payload);

    // Every supported payload type requires employeeId; payload is validated above.
    const employeeId = input.payload.employeeId as string;

    this.logger.debug(
      `Submitting ${input.eventType} for employee ${employeeId} (key ${input.idempotencyKey})`,
    );

    // Fast-path: a prior submission for this key already exists.
    const existing = await this.readStoredResponse(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    return this.insertEvent(input, employeeId);
  }

  private async readStoredResponse(
    idempotencyKey: string,
  ): Promise<SubmissionResult | null> {
    const row = await this.prisma.payrollEvent.findUnique({
      where: { idempotencyKey },
      select: { responseStatus: true, responseBody: true },
    });
    if (!row) {
      return null;
    }
    return {
      httpStatus: row.responseStatus,
      body: row.responseBody as Record<string, unknown>,
    };
  }

  private async insertEvent(
    input: CreateEventInput,
    employeeId: string,
  ): Promise<SubmissionResult> {
    const id = randomUUID();

    try {
      const sequence = await this.prisma.$transaction(async (tx) => {
        // Serialize inserts for one employee so MAX(sequence)+1 is race-free (R6).
        // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns Postgres `void`,
        // which Prisma's queryRaw result deserializer cannot map.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${employeeId}))`;

        const rows = await tx.$queryRaw<Array<{ max: bigint | null }>>`
          SELECT COALESCE(MAX(sequence), 0) AS max
          FROM "payroll_events"
          WHERE employee_id = ${employeeId}`;
        const next = (rows[0]?.max ?? 0n) + 1n;

        await tx.payrollEvent.create({
          data: {
            id,
            eventType: input.eventType,
            employeeId,
            payload: input.payload as Prisma.InputJsonValue,
            sequence: next,
            idempotencyKey: input.idempotencyKey,
            status: EventStatus.RECEIVED,
            responseStatus: HttpStatus.CREATED,
            responseBody: { id, status: 'received' },
          },
        });

        return next;
      });

      this.logger.log(
        `Event ${id} persisted (${input.eventType}, employee ${employeeId})`,
      );

      // Background the queue so the 201 never depends on Redis state. The row is
      // marked `queued` first (always recoverable), then enqueued best-effort.
      await this.markQueued(id, employeeId);
      await this.enqueueBestEffort({
        id,
        eventType: input.eventType,
        employeeId,
        sequence,
      });

      return { httpStatus: HttpStatus.CREATED, body: { id, status: 'received' } };
    } catch (error) {
      // Concurrent duplicate raced past the pre-check: the unique key rejects,
      // the winning row commits, and we return ITS stored response (no second row).
      if (this.isUniqueViolation(error)) {
        this.logger.debug(
          `Unique violation on key ${input.idempotencyKey} — returning stored response`,
        );
        const stored = await this.readStoredResponse(input.idempotencyKey);
        if (stored) {
          return stored;
        }
      }
      throw error;
    }
  }

  /**
   * Marks the row `received → queued` (guarded, idempotent — a relay may have
   * already queued it). Failures are logged and never propagated: a submission
   * that cannot be marked queued still returns 201 and is recovered later.
   */
  private async markQueued(id: string, employeeId: string): Promise<void> {
    try {
      const { count } = await this.prisma.payrollEvent.updateMany({
        where: { id, status: EventStatus.RECEIVED },
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
    eventType: EventType;
    employeeId: string;
    sequence: bigint;
  }): Promise<void> {
    try {
      await Promise.race([
        this.eventQueue.enqueue({
          eventId: input.id,
          eventType: input.eventType,
          employeeId: input.employeeId,
          sequence: Number(input.sequence),
        }),
        this.enqueueTimeout(),
      ]);
    } catch (error) {
      this.logger.error(
        `Enqueue failed for event ${input.id} (${input.eventType}, employee ${input.employeeId}, seq ${input.sequence}): ${this.errorMessage(error)}`,
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

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }
}