import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type IdempotencyOutcome = 'stored' | 'replay' | 'expired' | 'race';

/**
 * Minimum shape an operation must return to be persisted as a stored response.
 * Callers may return extra fields (e.g. `sequence`); they flow back but are not
 * persisted.
 */
export interface IdempotencyOpResult {
  status: number;
  body: Record<string, unknown>;
}

const IDEMPOTENCY_DEFAULT_TTL_SECONDS = 86400;

/**
 * Generic store-and-replay idempotency for an (organization, scope, key) triple:
 *
 *   - non-expired record → serve the stored { status, body }, `op` never runs
 *   - expired record    → treated as absent (logged distinctly), `op` runs
 *   - miss              → `op` runs inside a transaction and its response is
 *                         persisted in the same commit (exactly-once)
 *   - P2002 race        → the winner committed; the loser's transaction (op side
 *                         effects included) rolled back, and the winner's stored
 *                         response is served — never an error
 *
 * The UNIQUE (organization_id, scope, key) constraint on idempotency_records — not
 * this code — is the arbiter of idempotency.
 *
 * **Why the organization is part of the key.** Idempotency keys are chosen by
 * clients, so they are only unique *within a tenant*. If the key were global, two
 * organizations that happened to pick the same value would collide, and the second
 * would be served the first organization's stored response body — a cross-tenant
 * data leak, not merely a duplicate-suppression bug. Passing the organization as a
 * required first argument makes that structurally impossible to forget.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async execute<TOp extends IdempotencyOpResult>(
    organizationId: string,
    scope: string,
    key: string,
    op: (tx: Prisma.TransactionClient) => Promise<TOp>,
  ): Promise<TOp> {
    const recorded = await this.prisma.idempotencyRecord.findUnique({
      where: { organizationId_scope_key: { organizationId, scope, key } },
    });

    if (recorded) {
      if (recorded.expiresAt > new Date()) {
        this.logDecision(organizationId, scope, key, 'replay', recorded.responseStatus);
        return this.asStoredResponse(recorded) as TOp;
      }
      // Observable as a distinct outcome before being treated as absent.
      this.logDecision(organizationId, scope, key, 'expired', recorded.responseStatus);
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // A row seen as expired at the pre-check must be made absent before the
        // create, or UNIQUE (organization_id, scope, key) would reject the reuse. The
        // filter keeps only still-expired rows (a concurrent winner's fresh record is
        // untouched); when there was no record this is a no-op. Exactly-once is
        // preserved under concurrency: two callers may both delete the same expired
        // row and both run op, but only one create commits; the loser's state changes
        // roll back and P2002 → the winner's fresh stored response is served below.
        await tx.idempotencyRecord.deleteMany({
          where: { organizationId, scope, key, expiresAt: { lt: new Date() } },
        });

        const opResult = await op(tx);
        await tx.idempotencyRecord.create({
          data: {
            organizationId,
            scope,
            key,
            responseStatus: opResult.status,
            responseBody: opResult.body as Prisma.InputJsonValue,
            expiresAt: this.expiry(),
          },
        });
        return opResult;
      });

      this.logDecision(organizationId, scope, key, 'stored', result.status);
      return result;
    } catch (error) {
      // A concurrent duplicate raced past the pre-check: the winner's record
      // committed, ours rolled back. Serve THEIR stored response.
      if (this.isUniqueViolation(error)) {
        const winner = await this.prisma.idempotencyRecord.findUnique({
          where: { organizationId_scope_key: { organizationId, scope, key } },
        });
        if (winner) {
          this.logDecision(organizationId, scope, key, 'race', winner.responseStatus);
          return this.asStoredResponse(winner) as TOp;
        }
      }
      throw error;
    }
  }

  private asStoredResponse(record: {
    responseStatus: number;
    responseBody: Prisma.JsonValue;
  }): IdempotencyOpResult {
    return {
      status: record.responseStatus,
      body: record.responseBody as Record<string, unknown>,
    };
  }

  private expiry(): Date {
    const ttlSeconds =
      this.configService.get<number>('IDEMPOTENCY_TTL_SECONDS') ??
      IDEMPOTENCY_DEFAULT_TTL_SECONDS;
    return new Date(Date.now() + ttlSeconds * 1000);
  }

  /**
   * Structured observability: organization, scope, key, outcome, and the returned
   * HTTP status. Keys are logged; payloads and response bodies are never logged.
   * Serialized to a single-line JSON string so one decision is one log line —
   * passing an object makes Nest's util.inspect print a multi-line `Object(4) {…}`
   * that interleaves with the worker's own output.
   */
  private logDecision(
    organizationId: string,
    scope: string,
    key: string,
    outcome: IdempotencyOutcome,
    httpStatus: number,
  ): void {
    const line = JSON.stringify({ organizationId, scope, key, outcome, httpStatus });
    if (outcome === 'expired') {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }
}
