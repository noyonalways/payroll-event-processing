/**
 * Base class for simulated payroll processing failures.
 *
 * `isTransient` distinguishes the two failure classes the
 * `retry-and-failure-strategy` change (#5) will react to: transient errors can
 * succeed on retry (exponential backoff), permanent errors are business-level
 * rejections retrying would not fix (reliability R1).
 */
export abstract class PayrollProcessingError extends Error {
  abstract readonly isTransient: boolean;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A failure that could succeed on a retried attempt (e.g. service unavailable). */
export class TransientPayrollFailureError extends PayrollProcessingError {
  readonly isTransient = true;
}

/** A business-level rejection that retrying would not fix (e.g. invalid change). */
export class PermanentPayrollFailureError extends PayrollProcessingError {
  readonly isTransient = false;
}