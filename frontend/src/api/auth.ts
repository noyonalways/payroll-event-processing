import { API_BASE_URL, JSON_HEADERS, rawRequest } from './client';
import type { SessionResponse } from '../lib/types';

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
