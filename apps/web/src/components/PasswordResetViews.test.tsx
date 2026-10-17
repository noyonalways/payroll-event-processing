import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthView } from './AuthView';
import { ResetPasswordView, resetTokenFromLocation } from './ResetPasswordView';

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
  history.replaceState(null, '', '/');
  sessionStorage.clear();
});

describe('ResetPasswordView', () => {
  it('parses the token from the path and hash forms', () => {
    expect(resetTokenFromLocation('/reset/tok-1', '')).toBe('tok-1');
    expect(resetTokenFromLocation('/', '#/reset/tok-2')).toBe('tok-2');
    expect(resetTokenFromLocation('/login', '')).toBeNull();
  });

  it('without a token it explains the link is invalid', () => {
    history.replaceState(null, '', '/');
    render(<ResetPasswordView />);
    expect(screen.getByTestId('reset-missing-token')).toBeInTheDocument();
  });

  it('completes the reset and routes back to sign-in messaging', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', '/reset/its-a-reset-token');
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    render(<ResetPasswordView />);
    await user.type(screen.getByTestId('reset-password-view').querySelector('input')!, 'brand-new-correct-horse');
    await user.click(screen.getByTestId('reset-submit'));

    await waitFor(() => expect(screen.getByTestId('reset-done')).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0];
    expect((url as string).endsWith('/auth/reset-password')).toBe(true);
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ token: 'its-a-reset-token', password: 'brand-new-correct-horse' }),
    );
  });

  it('dead tokens surface the opaque error', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', '/reset/dead-token');
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Reset token is no longer valid' }, 410));

    render(<ResetPasswordView />);
    await user.type(screen.getByTestId('reset-password-view').querySelector('input')!, 'a-long-enough-password');
    await user.click(screen.getByTestId('reset-submit'));

    await waitFor(() => expect(screen.getByTestId('reset-error')).toBeInTheDocument());
  });
});

describe('AuthView forgot/reset modes', () => {
  it('the forgot step hands the token to the reset step inline; reset returns to sign-in', async () => {
    const user = userEvent.setup();
    fetchMock
      // forgot-password: known email → token present
      .mockResolvedValueOnce(jsonResponse({ token: 'inline-token' }, 202))
      // reset-password: 204
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(<AuthView onAuthenticated={vi.fn()} />);

    await user.click(screen.getByTestId('forgot-link'));
    await user.type(screen.getByTestId('forgot-email'), 'owner@acme.example');
    await user.click(screen.getByTestId('auth-submit'));

    // The hand-off: the token is displayed and carried into the reset FORM.
    await waitFor(() => expect(screen.getByTestId('reset-token-display')).toBeInTheDocument());
    expect(screen.getByTestId('reset-token-display').textContent).toBe('inline-token');

    await user.type(screen.getByLabelText('New password'), 'a-fresh-correct-horse');
    await user.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(screen.getByText('Password updated. Sign in with your new password.')).toBeInTheDocument());
  });

  it('an unknown email stays on the forgot step with the neutral notice', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: null }, 202));

    render(<AuthView onAuthenticated={vi.fn()} />);
    await user.click(screen.getByTestId('forgot-link'));
    await user.type(screen.getByTestId('forgot-email'), 'ghost@nowhere.example');
    await user.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(screen.getByTestId('forgot-notice')).toBeInTheDocument());
    expect(screen.queryByTestId('reset-token-display')).not.toBeInTheDocument();
  });
});
