import { API_BASE_URL, ApiError, JSON_HEADERS, NetworkError, SessionExpiredError, request } from './client';
import type {
  EventActionResponse,
  EventListQuery,
  EventListResponse,
  EventStatusResponse,
  EventSubmissionResponse,
  SubmitEventBody,
} from '../lib/types';

// The transport (token attach + refresh-once-and-retry, error normalization)
// lives in ./client now; re-exported so existing callers keep importing the
// error types from here.
export { API_BASE_URL, ApiError, NetworkError, SessionExpiredError };

export interface SubmitEventResult {
  /** The key that was actually sent (fresh UUID unless the caller supplied one). */
  idempotencyKey: string;
  response: EventSubmissionResponse;
}

/**
 * POST /events with a mandatory `Idempotency-Key` header. Generates a fresh
 * UUID by default; callers may supply a key and will get it back verbatim so
 * the tracker can record it for traceability.
 */
export async function submitEvent(
  body: SubmitEventBody,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<SubmitEventResult> {
  const response = await request<EventSubmissionResponse>(`${API_BASE_URL}/events`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return { idempotencyKey, response };
}

/**
 * GET /events — one page of the organization's event history
 * (events-query-api). Filters compose with AND; `cursor` follows the previous
 * page's `nextCursor` for a stable, offset-free walk. Omitted filters are not
 * sent (everything is optional server-side, and an undeclared-but-sent
 * parameter would be rejected).
 */
export function fetchEventsPage(query: EventListQuery = {}): Promise<EventListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.eventType) params.set('eventType', query.eventType);
  if (query.employeeId) params.set('employeeId', query.employeeId);
  if (query.createdAfter) params.set('createdAfter', query.createdAfter);
  if (query.createdBefore) params.set('createdBefore', query.createdBefore);
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return request<EventListResponse>(
    `${API_BASE_URL}/events${qs ? `?${qs}` : ''}`,
    { headers: JSON_HEADERS },
  );
}

/**
 * GET /events/{id} — read-only lifecycle state + attempt trail.
 * A 404 (unknown id) is normalized into an `ApiError` like any other error.
 */
export function fetchEventStatus(id: string): Promise<EventStatusResponse> {
  return request<EventStatusResponse>(
    `${API_BASE_URL}/events/${encodeURIComponent(id)}`,
    { headers: JSON_HEADERS },
  );
}

/**
 * POST /events/{id}/retry — manual recovery of a terminal `failed` event
 * (event-recovery): moves it back to `queued` and schedules it again. No
 * Idempotency-Key: the guarded transition answers an already-applied action
 * with a structured 409 instead of a stored-response replay.
 */
export function retryEvent(id: string): Promise<EventActionResponse> {
  return request<EventActionResponse>(
    `${API_BASE_URL}/events/${encodeURIComponent(id)}/retry`,
    { method: 'POST', headers: JSON_HEADERS },
  );
}

/**
 * POST /events/{id}/cancel — manual recovery of a pending event: a guarded
 * transition to the terminal `cancelled` state. Same no-Idempotency-Key
 * contract as the retry action.
 */
export function cancelEvent(id: string): Promise<EventActionResponse> {
  return request<EventActionResponse>(
    `${API_BASE_URL}/events/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', headers: JSON_HEADERS },
  );
}
