/**
 * Client-side mirror of the API contracts this app consumes — the
 * `event-submission` (POST /events) and `event-status-api` (GET /events/{id})
 * capabilities plus the global structured error body. Kept in the frontend so
 * the UI never imports from the backend codebase.
 */

export const EVENT_TYPES = [
  'BANK_ACCOUNT_CHANGE',
  'ADDRESS_CHANGE',
  'SALARY_CHANGE',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Payload contract of `BANK_ACCOUNT_CHANGE` (event-submission). */
export interface BankAccountChangePayload {
  employeeId: string;
  effectiveDate: string;
  iban: string;
}

/** Payload contract of `ADDRESS_CHANGE` (event-submission). */
export interface AddressChangePayload {
  employeeId: string;
  effectiveDate: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

/** Payload contract of `SALARY_CHANGE` (event-submission). */
export interface SalaryChangePayload {
  employeeId: string;
  effectiveDate: string;
  newSalary: number;
  currency: string;
}

export type EventPayload =
  | BankAccountChangePayload
  | AddressChangePayload
  | SalaryChangePayload;

/** Lifecycle statuses reported by GET /events/{id}. */
export type LifecycleStatus =
  | 'received'
  | 'queued'
  | 'processing'
  | 'success'
  | 'failed';

export type AttemptStatus = 'SUCCESS' | 'FAILED';
export type AttemptErrorType = 'TEMPORARY' | 'PERMANENT';

/** Body of POST /events ({ eventType, payload }). */
export interface SubmitEventBody {
  eventType: EventType;
  payload: EventPayload;
}

/** The stored 201 response of POST /events (replayed on duplicate keys). */
export interface EventSubmissionResponse {
  id: string;
  status: 'received';
}

/** One terminal attempt from the append-only `event_attempts` trail. */
export interface EventAttempt {
  attemptNumber: number;
  status: AttemptStatus;
  errorType: AttemptErrorType | null;
  failedReason: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}

/** Response body of GET /events/{id}: lifecycle state + attempt trail. */
export interface EventStatusResponse {
  id: string;
  eventType: EventType;
  employeeId: string;
  sequence: number;
  status: LifecycleStatus;
  payload: EventPayload;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  result: Record<string, unknown> | null;
  attempts: EventAttempt[];
}

/** Structured error body produced by the API's global HttpExceptionFilter. */
export interface ErrorResponseDto {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}