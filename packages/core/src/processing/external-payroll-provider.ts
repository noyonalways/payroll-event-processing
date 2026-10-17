import { HandlerInput } from '@repo/shared';

/**
 * The external payroll operation one handler dispatches to
 * (real-provider-adapter design D1). The provider is RESOLVED PER EVENT from
 * the event's organization — the simulated provider is the default
 * implementation, and an organization with an active HTTP configuration gets
 * the HTTP adapter. Implementations raise the SAME two error classes the
 * claim/retry machinery understands (`TransientPayrollFailureError`,
 * `PermanentPayrollFailureError` from `@repo/shared`), so retry semantics are
 * provider-independent — nothing downstream may branch on which provider ran.
 *
 * The call happens INSIDE the claim transaction but writes nothing: the
 * provider-call-first / state-write-second handler order keeps exactly-once
 * (a failure aborts the claim; a success licenses the domain-state write).
 */
export interface ExternalPayrollOperation {
  organizationId: string;
  eventId: string;
  eventType: string;
  employeeId: string;
  /** JSON-safe sequence (Number(bigint)) — same convention as job data. */
  sequence: number;
  /** The validated payload row (per-type shape). */
  payload: Record<string, unknown>;
  /** 1-based processing attempt number. */
  attempt: number;
}

export interface ExternalPayrollResult {
  /** Opaque reference of the external operation — carried into the result. */
  reference: string;
}

export interface ExternalPayrollProvider {
  apply(operation: ExternalPayrollOperation): Promise<ExternalPayrollResult>;
}

/** Which implementation served an operation (metadata/logging only). */
export type ProviderKind = 'simulated' | 'http';

/** The processing handlers inject this; it resolves synchronously per event. */
export interface ExternalPayrollProviderResolver {
  /**
   * Resolves the provider for the event's organization: the HTTP adapter when
   * the org has an ACTIVE HTTP-mode configuration, the simulated provider
   * otherwise. Re-read per invocation — config changes take effect without a
   * restart (spec: no redeploy needed).
   */
  for(organizationId: string): Promise<{ kind: ProviderKind; provider: ExternalPayrollProvider }>;
}
