import { Injectable } from '@nestjs/common';
import { EventStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HandlerRegistry } from './handler-registry';
import { EventType } from '../events/event-type';
import { TransientPayrollFailureError } from './errors/payroll-processing.error';
import { ProcessingResult } from './processing.types';

/**
 * Outcome of `claimAndProcess`. Only `permanent-failure` and `success` carry a
 * payload for the caller's log lines; `skipped` means the job was stale or a
 * duplicate relay and the event was left untouched.
 */
export type EventClaimOutcome =
  | { outcome: 'skipped' }
  | { outcome: 'success'; reference: string }
  | { outcome: 'permanent-failure'; reason: string };

export interface EventClaimInput {
  eventId: string;
  /** Tenant the event belongs to — every read/write below is scoped by it. */
  organizationId: string;
  eventType: EventType | string;
  employeeId: string;
  /** JSON-safe sequence (Number(bigint)) — same convention as queue job data. */
  sequence: number;
  /** 1-based processing attempt number (job.attemptsMade + 1). */
  attempt: number;
}

/**
 * Row-locked, transactional processing repository (design D1, raw D5).
 *
 * The entire lifecycle — `SELECT … FOR UPDATE` row lock → guarded claim
 * (`queued → processing`) → payload read → handler dispatch → terminal write +
 * `event_attempts` row — runs inside ONE interactive Prisma transaction:
 *
 * - A transient handler failure RE-THROWS, which ABORTS the transaction and
 *   rolls the claim back to `queued`. There is no explicit
 *   `processing → queued` reset, so a crash or lost connection at ANY point
 *   before commit also leaves the row back in `queued` — never stuck in
 *   `processing` (R4).
 * - A permanent failure commits `processing → failed` and the FAILED attempt
 *   row together (R5); success commits `processing → success` + `result` +
 *   `processed_at` and the SUCCESS attempt row together (R5).
 * - The row lock guarantees that even with multiple workers, contenders block
 *   on the row; their guarded claim then matches 0 rows and they apply no
 *   side effects (R3).
 *
 * Every statement here is scoped by BOTH `id` and `organization_id`. The job data
 * carries the organization the producer enqueued it for, so a malformed or forged
 * job cannot reach another tenant's row even though it names a valid event id.
 */
@Injectable()
export class EventClaim {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: HandlerRegistry,
  ) {}

  async claimAndProcess(input: EventClaimInput): Promise<EventClaimOutcome> {
    const { eventId, organizationId, eventType, employeeId, sequence, attempt } = input;

    // Resolve the handler BEFORE opening the transaction: an unregistered
    // event type is a config error that must fail fast (registry contract),
    // and throwing inside the tx would roll back a claim for a job that can
    // never succeed.
    const strategy = this.registry.resolve(eventType);

    return this.prisma.$transaction(
      async (tx) => {
        // 1. Row lock (R3) — Prisma's query builder has no FOR UPDATE, so the
        //    supported path is `$queryRaw` on the transaction client. Scoped by
        //    organization as well as id so a job carrying a foreign event id (a
        //    corrupt or forged job) can never lock or mutate another tenant's row.
        await tx.$queryRaw`SELECT id FROM payroll_events WHERE id = ${eventId} AND organization_id = ${organizationId} FOR UPDATE`;

        // 2. Guarded claim: only a `queued` row may be claimed. A count of 0
        //    means the row is already processing/success/failed (stale job or
        //    duplicate relay) — apply no side effects, no handler dispatch.
        const claimed = await tx.payrollEvent.updateMany({
          where: { id: eventId, organizationId, status: EventStatus.QUEUED },
          data: { status: EventStatus.PROCESSING },
        });
        if (claimed.count === 0) {
          return { outcome: 'skipped' } as const;
        }

        // 3. Payload read inside the tx (the DB row stays the source of truth;
        //    the job data deliberately carries identity only).
        const row = await tx.payrollEvent.findFirst({
          where: { id: eventId, organizationId },
          select: { payload: true },
        });
        if (!row) {
          // Unreachable when a claim succeeded (the FOR UPDATE lock pins the
          // row for the tx lifetime) — defensive only.
          return { outcome: 'skipped' } as const;
        }

        // 4. Dispatch to the per-type handler. A transient failure re-throws,
        //    aborting the transaction so the claim rolls back to `queued`.
        //    Any other error is permanent: commit `processing → failed` +
        //    the FAILED attempt row atomically.
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
            throw error;
          }
          const reason = error instanceof Error ? error.message : String(error);
          await tx.payrollEvent.updateMany({
            where: { id: eventId, organizationId, status: EventStatus.PROCESSING },
            data: { status: EventStatus.FAILED },
          });
          await tx.eventAttempt.create({
            data: {
              eventId,
              attemptNumber: attempt,
              status: 'FAILED',
              errorType: 'PERMANENT',
              failedReason: reason,
            },
          });
          return { outcome: 'permanent-failure', reason } as const;
        }

        // 5. Success: terminal `processing → success` + result + processed_at,
        //    and the SUCCESS attempt row, committed together (R5).
        await tx.payrollEvent.updateMany({
          where: { id: eventId, organizationId, status: EventStatus.PROCESSING },
          data: {
            status: EventStatus.SUCCESS,
            processedAt: new Date(),
            result: result as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.eventAttempt.create({
          data: {
            eventId,
            attemptNumber: attempt,
            status: 'SUCCESS',
            result: result as unknown as Prisma.InputJsonValue,
          },
        });
        return { outcome: 'success', reference: result.reference } as const;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
}