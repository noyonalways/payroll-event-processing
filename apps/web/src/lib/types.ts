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

/** Lifecycle statuses reported by GET /events/{id} and the recovery actions. */
export type LifecycleStatus =
  | 'received'
  | 'queued'
  | 'processing'
  | 'success'
  | 'failed'
  | 'cancelled';

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

/** Body of POST /events/{id}/retry and POST /events/{id}/cancel: the row
 * fields the UI needs to update a history row in place. */
export interface EventActionResponse {
  id: string;
  status: LifecycleStatus;
  eventType: EventType;
  employeeId: string;
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

/**
 * One directory employee (employee-directory). `employeeNumber` is the
 * tenant-local identifier payloads carry as `employeeId`; `name` is null only
 * for rows adopted from pre-directory event history.
 */
export interface Employee {
  id: string;
  employeeNumber: string;
  name: string | null;
  department: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Body of GET /employees: one explicit page with its forward cursor. */
export interface EmployeeListResponse {
  data: Employee[];
  nextCursor: string | null;
  limit: number;
}

/** The query parameters GET /employees accepts, as the UI sends them. */
export interface EmployeeListQuery {
  active?: boolean;
  search?: string;
  /** Page size (1–100); the API defaults to 50 when omitted. */
  limit?: number;
  cursor?: string;
}

/** Body of POST /employees. */
export interface CreateEmployeeBody {
  employeeNumber: string;
  name: string;
  department?: string;
}

/** Body of PATCH /employees/{id} — employeeNumber is immutable API-side. */
export interface UpdateEmployeeBody {
  name?: string;
  department?: string;
  active?: boolean;
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

// ─── Membership management (org-membership-management) ──────────────────────

/** One member of the signed-in organization (GET /members). */
export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: MembershipRole;
  joinedAt: string;
}

/** Create/update role values the API accepts for a membership role change. */
export type MemberRole = MembershipRole;

/** One invitation record (GET /invitations — accept tokens are never listed). */
export interface Invitation {
  id: string;
  email: string;
  role: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** POST /invitations response — the ONLY place the one-time token appears. */
export interface InvitationCreated extends Invitation {
  acceptToken: string;
  acceptUrl: string;
}

export interface CreateInvitationBody {
  email: string;
  role: 'ADMIN' | 'MEMBER';
}

export interface AcceptInvitationBody {
  token: string;
  password: string;
}

/** POST /invitations/accept result — everything the sign-in hand-off needs. */
export interface AcceptInvitationResult {
  organizationId: string;
  organizationName: string;
  role: string;
  email: string;
}

// ─── Webhook management (integrator-webhooks UI) ─────────────────────────────

/** One registered webhook endpoint (GET /webhook-endpoints — never the secret). */
export interface WebhookEndpoint {
  id: string;
  label: string;
  url: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /webhook-endpoints response — the ONLY place the signing secret appears. */
export interface WebhookEndpointCreated extends WebhookEndpoint {
  signingSecret: string;
}

export interface CreateWebhookBody {
  label: string;
  url: string;
}

export interface UpdateWebhookBody {
  label?: string;
  url?: string;
  active?: boolean;
}

/** One recorded delivery POST attempt (the trail integrators debug with). */
export interface WebhookDeliveryAttempt {
  id: string;
  attemptNumber: number;
  outcome: 'DELIVERED' | 'FAILED';
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
}

/** One webhook delivery: terminal notification + lifecycle state + trail. */
export interface WebhookDelivery {
  id: string;
  webhookEndpointId: string | null;
  url: string;
  eventId: string;
  terminalStatus: 'SUCCESS' | 'FAILED' | 'CANCELLED';
  payload: Record<string, unknown>;
  status: 'PENDING' | 'DELIVERED' | 'DEAD_LETTERED';
  attempts: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  deadLetterReason: string | null;
  createdAt: string;
  attemptTrail: WebhookDeliveryAttempt[];
}

// ─── Provider configuration (real-provider-adapter UI) ───────────────────────

/** GET /provider-config — the credential is never returned by reads. */
export interface ProviderConfig {
  mode: 'SIMULATED' | 'HTTP';
  baseUrl: string | null;
}

/** PUT /provider-config response — the credential appears EXACTLY once. */
export interface ProviderConfigSaved extends ProviderConfig {
  credential: string;
}

export interface UpsertProviderConfigBody {
  mode: 'SIMULATED' | 'HTTP';
  baseUrl?: string;
  credential?: string;
}

/** POST /auth/forgot-password acknowledgement (token present = account exists). */
export interface ForgotPasswordAcknowledgement {
  token: string | null;
}
