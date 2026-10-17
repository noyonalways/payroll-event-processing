import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Member } from '../lib/types';
import { setSession } from '../lib/session';
import { MembersView } from './MembersView';

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
  // A signed-in OWNER session: MembersView reads the stored role to decide
  // which management controls to render. Individual tests override the role.
  setSession({
    user: { id: 'u-owner', email: 'owner@acme.example', name: 'Ada' },
    organization: { id: 'org-1', name: 'Acme Payroll', slug: 'acme' },
    role: 'OWNER',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresIn: '15m',
    refreshExpiresAt: '2026-11-14T12:00:00.000Z',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const member = (overrides: Partial<Member> = {}): Member => ({
  userId: 'u-2',
  email: 'bob@acme.example',
  name: 'Bob',
  role: 'MEMBER',
  joinedAt: '2026-10-16T09:00:00.000Z',
  ...overrides,
});

async function seedRoster(members: Member[], invited: unknown[] = []) {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(members))
    .mockResolvedValueOnce(jsonResponse(invited));
}

describe('MembersView', () => {
  it('a MEMBER sees the read-only roster — no invite form, no role selects, no remove', async () => {
    setSession({
      user: { id: 'u-m', email: 'm@acme.example', name: 'Mem' },
      organization: { id: 'org-1', name: 'Acme Payroll', slug: 'acme' },
      role: 'MEMBER',
      accessToken: 'a',
      refreshToken: 'r',
      tokenType: 'Bearer',
      expiresIn: '15m',
      refreshExpiresAt: '2026-11-14T12:00:00.000Z',
    });
    await seedRoster([member()]);

    render(<MembersView />);

    await waitFor(() => expect(screen.getByTestId('member-row')).toBeInTheDocument());
    expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/role-select-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/remove-/)).toHaveLength(0);
  });

  it('an ADMIN sees the invite form but not role selects or remove buttons', async () => {
    setSession({
      user: { id: 'u-a', email: 'a@acme.example', name: 'Adm' },
      organization: { id: 'org-1', name: 'Acme Payroll', slug: 'acme' },
      role: 'ADMIN',
      accessToken: 'a',
      refreshToken: 'r',
      tokenType: 'Bearer',
      expiresIn: '15m',
      refreshExpiresAt: '2026-11-14T12:00:00.000Z',
    });
    await seedRoster([member()]);
    render(<MembersView />);

    await waitFor(() => expect(screen.getByTestId('invite-form')).toBeInTheDocument());
    expect(screen.queryAllByTestId(/role-select-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/remove-/)).toHaveLength(0);
  });

  it('the OWNER invites a member and the one-time accept URL is shown for hand-off', async () => {
    const user = userEvent.setup();
    await seedRoster([member()], []);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'inv-1',
        email: 'new@acme.example',
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
    render(<MembersView />);

    await waitFor(() => expect(screen.getByTestId('invite-email')).toBeInTheDocument());
    await user.type(screen.getByTestId('invite-email'), 'new@acme.example');
    await user.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(screen.getByTestId('invite-handoff')).toBeInTheDocument());
    const handoff = screen.getByTestId('invite-handoff');
    expect(handoff.textContent).toContain('/invite/');
  });

  it('a failed invite surfaces the structured error (403 path included)', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse([member()]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({ message: 'A pending invitation for this email already exists' }, 409),
      );
    render(<MembersView />);

    await waitFor(() => expect(screen.getByTestId('invite-email')).toBeInTheDocument());
    await user.type(screen.getByTestId('invite-email'), 'dup@acme.example');
    await user.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(screen.getByTestId('members-action-error')).toBeInTheDocument());
    expect(screen.getByTestId('members-action-error').textContent).toContain(
      'pending invitation',
    );
  });
});
