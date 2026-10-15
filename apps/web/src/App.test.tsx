import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { API_BASE_URL, SessionExpiredError } from './api/client';
import { fetchEventStatus } from './api/events';
import { clearSession, getSession, setSession } from './lib/session';
import { TRACKED_EVENTS_STORAGE_KEY } from './lib/storage';
import type { TrackedEvent } from './lib/storage';
import type { SessionResponse } from './lib/types';

function sessionResponse(): SessionResponse {
  return {
    user: { id: 'u-1', email: 'owner@acme.example', name: 'Ada Lovelace' },
    organization: { id: 'org-1', name: 'Acme Payroll', slug: 'acme-payroll' },
    role: 'OWNER',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresIn: '15m',
    refreshExpiresAt: '2026-11-14T12:00:00.000Z',
  };
}

const trackedEvent: TrackedEvent = {
  id: 'e-1',
  eventType: 'BANK_ACCOUNT_CHANGE',
  employeeId: 'emp-1',
  lastStatus: 'queued',
  attempts: 0,
  submittedAt: '2026-08-26T00:00:00.000Z',
  idempotencyKey: 'key-1',
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  clearSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App session gate', () => {
  it('shows the sign-in view when there is no session', () => {
    render(<App />);

    expect(screen.getByTestId('auth-submit')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /submit an event/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /tracked events/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the event workspace and the acting organization with a session', () => {
    setSession(sessionResponse());

    render(<App />);

    expect(
      screen.getByRole('heading', { name: /submit an event/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /tracked events/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/acting in/i)).toBeInTheDocument();
    expect(screen.getByText('Acme Payroll')).toBeInTheDocument();
    expect(screen.getByText('owner@acme.example')).toBeInTheDocument();
  });

  it('returns to sign-in when the refresh is rejected mid-session', async () => {
    setSession(sessionResponse());
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 401,
          message: 'Unauthorized',
          error: 'UnauthorizedException',
          timestamp: '2026-08-26T00:00:00.000Z',
          path: '/events/e-1',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<App />);
    expect(
      screen.getByRole('heading', { name: /submit an event/i }),
    ).toBeInTheDocument();

    // Any in-flight authenticated request (here: a status poll) that cannot be
    // refreshed forces the sign-out.
    await act(async () => {
      await expect(fetchEventStatus('e-1')).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
    });

    expect(screen.getByTestId('auth-submit')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /submit an event/i }),
    ).not.toBeInTheDocument();
  });

  it('sign-out revokes the token, clears local state, and returns to sign-in', async () => {
    setSession(sessionResponse());
    localStorage.setItem(TRACKED_EVENTS_STORAGE_KEY, JSON.stringify([trackedEvent]));
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(getSession()).toBeNull());
    expect(localStorage.getItem(TRACKED_EVENTS_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('auth-submit')).toBeInTheDocument();

    const logoutCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/auth/logout'),
    );
    expect(logoutCall).toBeDefined();
    const [url, init] = logoutCall as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/logout`);
    expect(JSON.parse(init.body as string)).toEqual({
      refreshToken: 'refresh-1',
    });
  });
});
