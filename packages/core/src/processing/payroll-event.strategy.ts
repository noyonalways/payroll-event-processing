import { Prisma } from '@prisma/client';
import { HandlerInput, ProcessingResult } from '@repo/shared';

/**
 * Strategy contract for one payroll event type. New event types implement this
 * interface and register in the `HandlerRegistry` — no worker or controller
 * changes (reliability R7, extensibility).
 *
 * The second parameter is the LIVE interactive transaction client the claim
 * holds (domain-effects design D2): a handler that persists domain state does
 * so through it, so the state write commits (or rolls back) together with the
 * claim and the terminal transition — never outside the event's exactly-once
 * boundary. Transaction-agnostic handlers can simply ignore it.
 */
export interface PayrollEventStrategy {
  handle(input: HandlerInput, tx: Prisma.TransactionClient): Promise<ProcessingResult>;
}
