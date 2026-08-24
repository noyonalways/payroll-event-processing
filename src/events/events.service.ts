import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { Prisma, EventStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
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
 *
 * The DB unique key — not this code — is the arbiter of idempotency (R2).
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payloadValidator: PayloadValidator,
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
      await this.prisma.$transaction(async (tx) => {
        // Serialize inserts for one employee so MAX(sequence)+1 is race-free (R6).
        // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns Postgres `void`,
        // which Prisma's queryRaw result deserializer cannot map.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${employeeId}))`;

        const rows = await tx.$queryRaw<Array<{ max: bigint | null }>>`
          SELECT COALESCE(MAX(sequence), 0) AS max
          FROM "payroll_events"
          WHERE employee_id = ${employeeId}`;
        const sequence = (rows[0]?.max ?? 0n) + 1n;

        await tx.payrollEvent.create({
          data: {
            id,
            eventType: input.eventType,
            employeeId,
            payload: input.payload as Prisma.InputJsonValue,
            sequence,
            idempotencyKey: input.idempotencyKey,
            status: EventStatus.RECEIVED,
            responseStatus: HttpStatus.CREATED,
            responseBody: { id, status: 'received' },
          },
        });
      });

      this.logger.log(
        `Event ${id} persisted (${input.eventType}, employee ${employeeId})`,
      );
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

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }
}