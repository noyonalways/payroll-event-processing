import { API_BASE_URL, ApiError, JSON_HEADERS, NetworkError, SessionExpiredError, request } from './client';
import type {
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
 * GET /events/{id} — read-only lifecycle state + attempt trail.
 * A 404 (unknown id) is normalized into an `ApiError` like any other error.
 */
export function fetchEventStatus(id: string): Promise<EventStatusResponse> {
  return request<EventStatusResponse>(
    `${API_BASE_URL}/events/${encodeURIComponent(id)}`,
    { headers: JSON_HEADERS },
  );
}
