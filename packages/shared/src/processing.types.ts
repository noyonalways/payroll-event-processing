import { EventType } from './event-type';

/**
 * The context a worker hands to a processing handler. The handler sees the
 * event identity plus the validated `payload` row (per-type shape) and the
 * 1-based attempt number. A plain string `organizationId` travels on PURPOSE —
 * the shared package stays free of Prisma/database types; handlers that
 * persist bounded state use it as the tenant discriminator (domain-effects
 * design D2).
 */
export interface HandlerInput {
  /**
   * Tenant the event belongs to, bound into every read/write the claim makes.
   * Inherited authority: handlers never trust it from the payload — it arrives
   * from the job data already validated against the event row's organization.
   */
  organizationId: string;
  eventId: string;
  eventType: EventType;
  employeeId: string;
  /** JSON-safe sequence (Number(bigint)) — same convention as queue job data. */
  sequence: number;
  /** The validated event payload row from `payroll_events.payload`. */
  payload: Record<string, unknown>;
  /** 1-based processing attempt number. */
  attempt: number;
}

/**
 * Success contract produced by a processing handler and persisted to the
 * `payroll_events.result` column (design D3). Identifies the simulated external
 * operation, the employee, the effective date, and the affected fields.
 */
export interface ProcessingResult {
  /** Opaque reference of the simulated external operation. */
  reference: string;
  employeeId: string;
  effectiveDate: string;
  /** Per-type affected fields with their applied values. */
  acknowledged: Record<string, unknown>;
}