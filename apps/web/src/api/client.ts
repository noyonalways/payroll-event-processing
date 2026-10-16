import { clearSession, getSession, setSession } from '../lib/session';
import type { ErrorResponseBody } from '@repo/shared';
import type { SessionResponse } from '../lib/types';

/**
 * Base origin of the payroll API. Configurable at build time via
 * `VITE_API_URL` (defaults to the local dev API origin). The API has CORS
 * enabled globally, so the Vite dev server and the nginx container call it
 * directly.
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

function messageText(message: string | string[]): string {
  return Array.isArray(message) ? message.join(' ') : message;
}

/**
 * Raised for any non-2xx API response, carrying the structured
 * `ErrorResponseBody` produced by the global HttpExceptionFilter.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly body: ErrorResponseBody;

  constructor(statusCode: number, body: ErrorResponseBody) {
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

/**
 * The session could not be renewed: the refresh token was rejected (unknown,
 * expired, or already rotated away). The session has been cleared, so the UI
 * is already back at the sign-in step. The event history needs no clearing —
 * it is server-owned and re-scoped by whatever session signs in next.
 */
export class SessionExpiredError extends Error {
  constructor(cause?: unknown) {
    super('Session expired — sign in again', { cause });
    this.name = 'SessionExpiredError';
  }
}

/** Parse a non-2xx response body defensively into the documented shape. */
async function parseErrorBody(res: Response): Promise<ErrorResponseBody> {
  try {
    const body = (await res.json()) as Partial<ErrorResponseBody>;
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

async function transport(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new NetworkError(cause);
  }
}

async function parseBody<T>(res: Response): Promise<T> {
  // 204 No Content (POST /auth/logout) has no body to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Unauthenticated request — the transport behind the auth endpoints, which are
 * authorized by the credential in their own body. It never attaches a token and
 * never refreshes, so logging in/out and rotating can never recurse into the
 * client's refresh path.
 */
export async function rawRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await transport(url, init);
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return parseBody<T>(res);
}

/** Copy the caller's init and attach the current access token, if any. */
function authorizedInit(init: RequestInit): RequestInit {
  const session = getSession();
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  return { ...init, headers };
}

/**
 * Rotate the refresh token into a new session. Single-flight: concurrent 401s
 * share one rotation and the rest await it, so a burst of requests never spends
 * the same (single-use) refresh token twice.
 */
let refreshInFlight: Promise<void> | null = null;

function refreshSession(): Promise<void> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function performRefresh(): Promise<void> {
  const session = getSession();
  if (!session) {
    expireSession();
    throw new SessionExpiredError();
  }
  let rotated: SessionResponse;
  try {
    rotated = await rawRequest<SessionResponse>(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
  } catch (cause) {
    if (cause instanceof NetworkError) {
      // The refresh never ran (API unreachable). Keep the session: signing the
      // user out on a network blip would be wrong, and the next poll retries.
      throw cause;
    }
    expireSession();
    throw new SessionExpiredError(cause);
  }
  setSession(rotated);
}

/** Local sign-out: drop the session (the history is server-owned, not local). */
function expireSession(): void {
  clearSession();
}

/**
 * Authenticated request: attaches the current access token and, on a 401,
 * rotates the refresh token once and replays the request with the new one.
 * Never retries more than once — a second 401 after a successful refresh means
 * the endpoint is refusing this identity, not the token, so it is surfaced
 * as-is and the (fresh) session is kept.
 */
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res = await transport(url, authorizedInit(init));

  if (res.status === 401) {
    await refreshSession();
    res = await transport(url, authorizedInit(init));
  }

  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return parseBody<T>(res);
}

/**
 * Authenticated RAW response — the streaming twin of `request` (realtime-status):
 * the same single 401 → refresh rotation → replay, the same error
 * normalization, but the `Response` is returned untouched so the caller can
 * consume its body incrementally (an SSE stream is not JSON to parse once).
 */
export async function fetchAuthorized(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let res = await transport(url, authorizedInit(init));

  if (res.status === 401) {
    await refreshSession();
    res = await transport(url, authorizedInit(init));
  }

  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return res;
}
