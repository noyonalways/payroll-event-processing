import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL, ApiError } from './client';
import {
  acceptInvitation,
  createInvitation,
  fetchMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from './members';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('members api', () => {
  it('fetchMembers GETs the roster', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ userId: 'u-1', role: 'OWNER' }]));

    const members = await fetchMembers();

    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/members`, expect.anything());
    expect(members).toHaveLength(1);
  });

  it('updateMemberRole PATCHes the role path with the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ userId: 'u-1', role: 'ADMIN' }));

    await updateMemberRole('u-1', 'ADMIN');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/members/u-1/role`);
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).body).toBe(JSON.stringify({ role: 'ADMIN' }));
  });

  it('removeMember DELETEs the membership', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await removeMember('u-2');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/members/u-2`);
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('createInvitation POSTs and surfaces the one-time token response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'inv-1',
        email: 'ada@acme.example',
        role: 'MEMBER',
        status: 'PENDING',
        invitedBy: 'u-owner',
        expiresAt: '2026-10-23T00:00:00.000Z',
        acceptedAt: null,
        createdAt: '2026-10-16T00:00:00.000Z',
        acceptToken: 'tok-1',
        acceptUrl: '/invite/tok-1',
      }),
    );

    const created = await createInvitation({ email: 'ada@acme.example', role: 'MEMBER' });

    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(created.acceptToken).toBe('tok-1');
  });

  it('revokeInvitation DELETEs the invitation', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await revokeInvitation('inv-9');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/invitations/inv-9`);
  });

  it('acceptInvitation POSTs the token-gated body and normalizes errors', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { message: 'Invitation is no longer valid' },
        410,
      ),
    );

    await expect(
      acceptInvitation({ token: 'dead', password: 'correct-horse-battery' }),
    ).rejects.toThrow(ApiError);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/invitations/accept`);
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ token: 'dead', password: 'correct-horse-battery' }),
    );
  });
});
