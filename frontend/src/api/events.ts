import type {
  ErrorResponseDto,
  EventStatusResponse,
  EventSubmissionResponse,
  SubmitEventBody,
} from '../lib/types';

/**
 * Base origin of the payroll API. Configurable at build time via
 * `VITE_API_URL` (defaults to the local dev API origin). The API has CORS
 * enabled globally, so the Vite dev server and the nginx container call it
 * directly.
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function messageText(message: string | string[]): string {
  return Array.isArray(message) ? message.join(' ') : message;
}

/**
 * Raised for any non-2xx API response, carrying the structured
 * `ErrorResponseDto` body produced by the global HttpExceptionFilter.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly body: ErrorResponseDto;

  constructor(statusCode: number, body: ErrorResponseDto) {
    super(messageText(body.message));
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** The request never reached the server (network failure / CORS / DNS). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the payroll API', { cause });
    this.name = 'NetworkError';
  }
}

/** Parse a non-2xx response body defensively into the documented shape. */
async function parseErrorBody(res: Response): Promise<ErrorResponseDto> {
  try {
    const body = (await res.json()) as Partial<ErrorResponseDto>;
    return {
      statusCode: body.statusCode ?? res.status,
      message: body.message ?? `Request failed with status ${res.status}`,
      error: body.error ?? res.statusText,
      timestamp: body.timestamp ?? new Date().toISOString(),
      path: body.path ?? '',
    };
  } catch {
    return {
      statusCode: res.status,
      message: res.statusText || `Request failed with status ${res.status}`,
      error: res.statusText,
      timestamp: new Date().toISOString(),
      path: '',
    };
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return (await res.json()) as T;
}

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