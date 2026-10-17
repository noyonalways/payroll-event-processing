import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcceptInviteView } from './AcceptInviteView';

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
  history.replaceState(null, '', '/invite/its-a-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('AcceptInviteView', () => {
  it('without a token in the URL it explains the link is invalid', () => {
    history.replaceState(null, '', '/');
    render(<AcceptInviteView />);
    expect(screen.getByTestId('invite-missing-token')).toBeInTheDocument();
  });

  it('the token comes from the URL only and acceptance shows the joined organization', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({
        organizationId: 'org-1',
        organizationName: 'Acme Payroll',
        role: 'MEMBER',
        email: 'new@acme.example',
      }),
    );

    render(<AcceptInviteView />);

    expect(screen.getByTestId('accept-invite-view')).toBeInTheDocument();
    await user.type(screen.getByTestId('invite-password'), 'correct-horse-battery');
    await user.click(screen.getByTestId('invite-accept'));

    await waitFor(() => expect(screen.getByTestId('invite-accepted')).toBeInTheDocument());
    expect(screen.getByTestId('invite-organization-id').textContent).toBe('org-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect((url as string).endsWith('/invitations/accept')).toBe(true);
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ token: 'its-a-token', password: 'correct-horse-battery' }),
    );
  });

  it('an unusable token (unknown/expired/wrong password — all indistinguishable) surfaces the error', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'Invitation is no longer valid' }, 410),
    );

    render(<AcceptInviteView />);
    await user.type(screen.getByTestId('invite-password'), 'correct-horse-battery');
    await user.click(screen.getByTestId('invite-accept'));

    await waitFor(() => expect(screen.getByTestId('invite-error')).toBeInTheDocument());
    expect(screen.getByTestId('invite-error').textContent).toContain('no longer valid');
  });
});
