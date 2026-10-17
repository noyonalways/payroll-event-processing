import { API_BASE_URL, JSON_HEADERS, rawRequest } from './client';
import type { ForgotPasswordAcknowledgement, SessionResponse } from '../lib/types';

/**
 * The auth endpoints. All of them run on the plain transport on purpose: they
 * are how a session is obtained or revoked, carry their credential in the body,
 * and a 401 here means "wrong credentials" — never "refresh and retry".
 */

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  organizationName: string;
  /** Optional: a blank name is omitted rather than sent as an empty string. */
  name?: string;
}

/** POST /auth/login — 401 on bad credentials; 400 if the account is in several organizations. */
export function login(input: LoginInput): Promise<SessionResponse> {
  return rawRequest<SessionResponse>(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** POST /auth/register — creates a new organization with the caller as OWNER. 409 if the email exists. */
export function register(input: RegisterInput): Promise<SessionResponse> {
  const body = {
    email: input.email,
    password: input.password,
    organizationName: input.organizationName,
    ...(input.name ? { name: input.name } : {}),
  };
  return rawRequest<SessionResponse>(`${API_BASE_URL}/auth/register`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/**
 * POST /auth/logout — revokes the refresh token server-side. Idempotent (always
 * 204), so callers clear local state regardless of the outcome.
 */
export function logout(refreshToken: string): Promise<void> {
  return rawRequest<void>(`${API_BASE_URL}/auth/logout`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ refreshToken }),
  });
}

/**
 * POST /auth/forgot-password — anti-enumeration by contract: the response is
 * IDENTICAL whether or not the email has an account. `token` is non-null only
 * when an account exists (this deployment's out-of-band hand-off); callers
 * must never treat `null` as an error and must render both cases the same.
 */
export function forgotPassword(email: string): Promise<ForgotPasswordAcknowledgement> {
  return rawRequest<ForgotPasswordAcknowledgement>(
    `${API_BASE_URL}/auth/forgot-password`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email }) },
  );
}

/**
 * POST /auth/reset-password — completes the reset with the single-use token:
 * new password + every live refresh token of the account revoked. 204 on
 * success; one opaque 410 for unknown/expired/used tokens (never tell which).
 */
export function resetPassword(token: string, password: string): Promise<void> {
  return rawRequest<void>(`${API_BASE_URL}/auth/reset-password`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, password }),
  });
}
