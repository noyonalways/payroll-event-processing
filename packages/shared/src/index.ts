/**
 * Public surface of @repo/shared — the values more than one deployable has to
 * agree on (design D2): the supported event types, the queue name and job name,
 * the idempotency constants and header contract, the processing result type,
 * the processing error classes, and the demo-scenario mapping. None of these
 * needs Nest, Prisma, or Redis (verified in the extraction task 6.4).
 */
export { EventType } from './event-type';
export { PAYROLL_EVENTS_QUEUE, PAYROLL_EVENT_JOB } from './queue.constants';
export {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_SCOPE_EVENT_SUBMISSION,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PRINTABLE_ASCII,
} from './idempotency.constants';
export { HandlerInput, ProcessingResult } from './processing.types';
export {
  PayrollProcessingError,
  TransientPayrollFailureError,
  PermanentPayrollFailureError,
} from './errors/payroll-processing.error';
export {
  DEMO_EMPLOYEE_PREFIX,
  DEMO_RECOVER_THRESHOLD_ATTEMPT,
  DEMO_FAIL_THRESHOLD_ATTEMPT,
  DEMO_PACING_MIN_MS,
  DEMO_PACING_MAX_MS,
} from './demo-scenarios';
export type { DemoScenario } from './demo-scenarios';
export { demoScenarioFor } from './demo-scenarios';
