/**
 * The API contracts this app consumes — the `event-submission` (POST /events)
 * and `event-status-api` (GET /events/{id}) capabilities. The event-type
 * contract and the structured error body are the workspace's single copies in
 * `@repo/shared` (design D2); only response types the backend expresses as
 * classes (DTOs) are mirrored here.
 */
import { EventType as SharedEventType } from '@repo/shared';

/**
 * The UI-wide event-type type: the literal union of the shared contract's
 * values, derived (not redefined) from the shared enum, so the demo form keeps
 * literal-based typing and a new backend event type surfaces here
 * automatically. Its form metadata is then forced by
 * `Record<EventType, FieldSpec[]>` in `lib/eventTypes.ts`.
 */
export type EventType = `${SharedEventType}`;

/**
 * The event types the demo form offers. Enum-derived rather than hand-written,
 * so the UI can no longer drift from what the API accepts.
 */
export const EVENT_TYPES: readonly EventType[] = Object.values(
  SharedEventType,
) as EventType[];

/**
 * The payload interface mirrors of the backend payload DTOs, plus the union
 * the submit/status bodies carry.
 */

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

/** Payload contract of `DEPARTMENT_CHANGE` (event-submission). */
export interface DepartmentChangePayload {
  employeeId: string;
  effectiveDate: string;
  newDepartment: string;
}

export type EventPayload =
  | BankAccountChangePayload
  | AddressChangePayload
  | SalaryChangePayload
  | DepartmentChangePayload;

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

/** One processing attempt from the append-only `event_attempts` trail. */
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

/**
 * One row of the event-history page (GET /events, events-query-api): identity,
 * shape, and timing only — deliberately no payload, attempt trail, or result.
 */
export interface EventListItem {
  id: string;
  eventType: EventType;
  employeeId: string;
  sequence: number;
  status: LifecycleStatus;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

/** Body of GET /events: one explicit page with its forward cursor. */
export interface EventListResponse {
  data: EventListItem[];
  nextCursor: string | null;
  limit: number;
}

/** The query parameters GET /events accepts, as the UI sends them. */
export interface EventListQuery {
  status?: LifecycleStatus;
  eventType?: EventType;
  employeeId?: string;
  createdAfter?: string;
  createdBefore?: string;
  /** Page size (1–100); the API defaults to 20 when omitted. */
  limit?: number;
  cursor?: string;
}

/** Role held within an organization (mirrors the Prisma membership enum). */
export type MembershipRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export interface SessionOrganization {
  id: string;
  name: string;
  slug: string;
}

/** The caller's identity in a tenant, without credential material (GET /auth/me). */
export interface ActorIdentity {
  user: SessionUser;
  organization: SessionOrganization;
  role: MembershipRole;
}

/**
 * Response of POST /auth/register, /auth/login, and /auth/refresh. The only
 * shape that carries credentials; the refresh token in it is single-use and
 * rotated on every refresh.
 */
export interface SessionResponse extends ActorIdentity {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: string;
  refreshExpiresAt: string;
}