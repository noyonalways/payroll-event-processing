import { Injectable, Logger, HttpStatus, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, EventStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@repo/database';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { IDEMPOTENCY_SCOPE_EVENT_SUBMISSION, EventType } from '@repo/shared';
import { PayloadValidator } from './payload.validator';
import { EventStatusResponseDto } from './dto/event-status-response.dto';
import {
  DEFAULT_PAGE_LIMIT,
  EventListItemDto,
  EventListResponseDto,
} from './dto/events-list.dto';

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
 * Filters and pagination controls of the event-history query (events-query-api).
 * All fields optional; values are already DTO-validated at the HTTP boundary.
 */
export interface EventListFilters {
  status?: string;
  eventType?: EventType;
  employeeId?: string;
  /** Inclusive ISO-8601 lower bound on created_at. */
  createdAfter?: string;
  /** Inclusive ISO-8601 upper bound on created_at. */
  createdBefore?: string;
  limit?: number;
  cursor?: string | null;
}

/**
 * A pagination position: the (created_at, id) pair of the last row served.
 * Versioned so the encoding can evolve without silently misdialing old tokens.
 */
interface EventListCursor {
  v: number;
  /** ISO-8601 creation timestamp of the last row of the previous page. */
  t: string;
  /** Event id of the last row of the previous page (tiebreaker). */
  i: string;
}

const CURSOR_VERSION = 1;

/**
 * The opaque `nextCursor` token for the page following `row`: a base64url
 * (hence URL-safe) encoding of the versioned (created_at, id) position.
 */
export function encodeEventListCursor(row: {
  createdAt: Date;
  id: string;
}): string {
  const payload: EventListCursor = {
    v: CURSOR_VERSION,
    t: row.createdAt.toISOString(),
    i: row.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a client-supplied cursor back into its seek position. An
 * undecodable, foreign, or corrupt token is a structured 400 — treating it as
 * "page one" would silently re-serve data the client has already seen.
 */
export function decodeEventListCursor(cursor: string): EventListCursor {
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    throw new BadRequestException('cursor is not a valid event-list cursor');
  }
  const c = parsed as Partial<EventListCursor> | null;
  if (
    typeof c !== 'object' ||
    c === null ||
    c.v !== CURSOR_VERSION ||
    typeof c.t !== 'string' ||
    Number.isNaN(Date.parse(c.t)) ||
    typeof c.i !== 'string' ||
    c.i.length === 0
  ) {
    throw new BadRequestException('cursor is not a valid event-list cursor');
  }
  return c as EventListCursor;
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
   * Read-only event-history page (events-query-api, design D1/D2), scoped to the
   * caller's organization — the same required-first-argument convention as
   * createEvent/getEventStatus. ONE findMany over `payroll_events` with a
   * narrow projection (payload, result, and the attempt trail are never read),
   * ordered `created_at DESC, id DESC`, filters AND-composed into the same
   * WHERE. Keyset pagination (D1): a cursor continues strictly after its
   * (created_at, id) position, so pages never shift while new events arrive.
   *
   * Strictly read-only (design D6): no create/update/delete call exists on this
   * path, nothing is enqueued — listing history can never affect lifecycle
   * state.
   */
  async listEvents(
    organizationId: string,
    filters: EventListFilters = {},
  ): Promise<EventListResponseDto> {
    const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;
    const seek = filters.cursor ? decodeEventListCursor(filters.cursor) : null;
    const seekTime = seek ? new Date(seek.t) : null;

    // Every condition is AND-composed by Prisma into ONE where clause: the
    // tenant boundary always holds, filters narrow it, and the cursor seek
    // continues the CURRENTLY FILTERED selection (it never restarts the
    // unfiltered query).
    const where: Prisma.PayrollEventWhereInput = {
      organizationId,
      ...(filters.status
        ? { status: filters.status.toUpperCase() as EventStatus }
        : {}),
      ...(filters.eventType ? { eventType: filters.eventType } : {}),
      ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
      ...(filters.createdAfter || filters.createdBefore
        ? {
            createdAt: {
              ...(filters.createdAfter
                ? { gte: new Date(filters.createdAfter) }
                : {}),
              ...(filters.createdBefore
                ? { lte: new Date(filters.createdBefore) }
                : {}),
            },
          }
        : {}),
      // "Strictly after the cursor" under created_at DESC, id DESC ordering:
      // createdAt earlier than the cursor's, or the same instant with a smaller
      // id. The id tiebreaker makes the position exact even when a burst of
      // submissions shares one timestamp.
      ...(seek && seekTime
        ? {
            OR: [
              { createdAt: { lt: seekTime } },
              { createdAt: seekTime, id: { lt: seek.i } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.payrollEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row answers "is there a next page?" without a second count.
      take: limit + 1,
      select: {
        id: true,
        eventType: true,
        employeeId: true,
        sequence: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        processedAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map(
        (row): EventListItemDto => ({
          id: row.id,
          eventType: row.eventType,
          employeeId: row.employeeId,
          // BigInt is not JSON-serializable — coerce at the API boundary (Number).
          sequence: Number(row.sequence),
          status: row.status.toLowerCase() as EventListItemDto['status'],
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          processedAt: row.processedAt ? row.processedAt.toISOString() : null,
        }),
      ),
      nextCursor: hasMore ? encodeEventListCursor(page[page.length - 1]) : null,
      limit,
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