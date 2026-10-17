import { API_BASE_URL, JSON_HEADERS, request } from './client';
import type {
  AcceptInvitationBody,
  AcceptInvitationResult,
  CreateInvitationBody,
  Invitation,
  InvitationCreated,
  Member,
} from '../lib/types';

// The transport (token attach + refresh-once-and-retry, error normalization)
// lives in ./client; re-exported so callers keep importing the error types
// from the surface they call.
export { API_BASE_URL, ApiError, NetworkError, SessionExpiredError } from './client';

/**
 * The membership surface (org-membership-management) over the authenticated
 * transport in ./client. `acceptInvitation` is deliberately PUBLIC-route —
 * `request` attaches the session token when there is one and the API ignores
 * it — and every dead-token case surfaces as a 410 {@link ApiError}.
 */

/** GET /members — the organization's roster with roles (any member). */
export function fetchMembers(): Promise<Member[]> {
  return request<Member[]>(`${API_BASE_URL}/members`, { headers: JSON_HEADERS });
}

/** PATCH /members/{userId}/role — OWNER-only role change. */
export function updateMemberRole(userId: string, role: Member['role']): Promise<Member> {
  return request<Member>(
    `${API_BASE_URL}/members/${encodeURIComponent(userId)}/role`,
    { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ role }) },
  );
}

/** DELETE /members/{userId} — OWNER-only removal (204; 403 self/last-owner rules). */
export function removeMember(userId: string): Promise<void> {
  return request<void>(`${API_BASE_URL}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

/** POST /invitations — ADMIN-only; the response carries the one-time token. */
export function createInvitation(
  body: CreateInvitationBody,
): Promise<InvitationCreated> {
  return request<InvitationCreated>(`${API_BASE_URL}/invitations`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** GET /invitations — ADMIN-only list (never carries tokens). */
export function fetchInvitations(): Promise<Invitation[]> {
  return request<Invitation[]>(`${API_BASE_URL}/invitations`, { headers: JSON_HEADERS });
}

/** DELETE /invitations/{id} — revoke a PENDING invitation (ADMIN-only). */
export function revokeInvitation(id: string): Promise<void> {
  return request<void>(`${API_BASE_URL}/invitations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** POST /invitations/accept — public, token-gated. Opaque 410 on any dead token. */
export function acceptInvitation(
  body: AcceptInvitationBody,
): Promise<AcceptInvitationResult> {
  return request<AcceptInvitationResult>(`${API_BASE_URL}/invitations/accept`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}
