import { Injectable } from '@nestjs/common';
import { DomainKind, Prisma } from '@prisma/client';

/** Everything one domain state row carries, as the handler declares it. */
export interface EmployeeDomainStateAppend {
  /** Tenant discriminator — the claim-validated organization. */
  organizationId: string;
  /** Tenant-local employee identifier (no directory FK, design D1). */
  employeeId: string;
  /** Which business domain the row captures. */
  domain: DomainKind;
  /** The payload's effective date (ISO-8601 string). */
  effectiveDate: string;
  /** The applied fields — exactly the event type's payload field set. */
  value: Record<string, unknown>;
  /** The event that produced this row; UNIQUE (source_event_id) arbitrates it. */
  sourceEventId: string;
}

/**
 * The one place an effective-dated state row is built (domain-effects design
 * D3): handlers declare WHAT changed (domain + applied values) and simply call
 * this with the claim's transaction client, so the insert shape and provenance
 * fields cannot drift between the four handlers.
 *
 * The write is deliberately plain: it neither retries nor swallows — a Unique
 * constraint violation (P2002 on `source_event_id`, D1's store-level
 * exactly-once arbiter) throws, which aborts the claim transaction rather than
 * committing an event without a matching state row.
 */
@Injectable()
export class EmployeeDomainStateWriter {
  async record(
    tx: Prisma.TransactionClient,
    append: EmployeeDomainStateAppend,
  ): Promise<void> {
    await tx.employeeDomainState.create({
      data: {
        organizationId: append.organizationId,
        employeeId: append.employeeId,
        domain: append.domain,
        value: append.value as Prisma.InputJsonValue,
        effectiveDate: new Date(append.effectiveDate),
        sourceEventId: append.sourceEventId,
      },
    });
  }
}
