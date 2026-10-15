import { HandlerInput, ProcessingResult } from '@repo/shared';

/**
 * Strategy contract for one payroll event type. New event types implement this
 * interface and register in the `HandlerRegistry` — no worker or controller
 * changes (reliability R7, extensibility).
 */
export interface PayrollEventStrategy {
  handle(input: HandlerInput): Promise<ProcessingResult>;
}