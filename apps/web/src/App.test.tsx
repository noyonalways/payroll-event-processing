import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { API_BASE_URL, SessionExpiredError } from './api/client';
import { fetchEventStatus } from './api/events';
import { clearSession, getSession, setSession } from './lib/session';
import type { EventListItem, SessionResponse } from './lib/types';

function sessionResponse(
  overrides: Partial<SessionResponse> = {},
): SessionResponse {
  return {
    user: { id: 'u-1', email: 'owner@acme.example', name: 'Ada Lovelace' },
    organization: { id: 'org-1', name: 'Acme Payroll', slug: 'acme-payroll' },
    role: 'OWNER',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresIn: '15m',
    refreshExpiresAt: '2026-11-14T12:00:00.000Z',
    ...overrides,
  };
}

const SESSION_STORAGE_KEY = 'payroll.auth.session.v1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listPage(data: EventListItem[] = []): {
  data: EventListItem[];
  nextCursor: string | null;
  limit: number;
} {
  return { data, nextCursor: null, limit: 20 };
}

function listRow(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-7',
    sequence: 4,
    status: 'success',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:01.000Z',
    processedAt: '2026-08-26T00:00:01.000Z',
    id,
    ...overrides,
  };
}

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
      screen.queryByRole('heading', { name: /event history/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the event workspace and the acting organization with a session', () => {
    setSession(sessionResponse());
    fetchMock.mockResolvedValue(jsonResponse(listPage()));

    render(<App />);

    expect(
      screen.getByRole('heading', { name: /submit an event/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /event history/i }),
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

  it('sign-out revokes the token, clears the session, and returns to sign-in', async () => {
    setSession(sessionResponse());
    fetchMock.mockImplementation((url: RequestInfo | URL) =>
      String(url) === `${API_BASE_URL}/events`
        ? Promise.resolve(jsonResponse(listPage()))
        : Promise.resolve(new Response(null, { status: 204 })),
    );
    const user = userEvent.setup();

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(getSession()).toBeNull());
    // The history is server-owned: clearing local state leaves only the
    // session key behind (and that one is gone after sign-out).
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
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

describe('App event history (server-driven)', () => {
  it('loads the organization history through the authenticated client on first render', async () => {
    setSession(sessionResponse());
    // The workspace route: events list for the history, a directory page for
    // the submit form's employee picker (actor-directory backed).
    fetchMock.mockImplementation((url: RequestInfo | URL) =>
      String(url).includes('/employees')
        ? Promise.resolve(
            jsonResponse({
              data: [],
              nextCursor: null,
              limit: 100,
            }),
          )
        : Promise.resolve(jsonResponse(listPage([listRow('e-history-1')]))),
    );

    render(<App />);

    // History FROM the server: a row the user never submitted in this session.
    // (event-type select options also carry the type name, so key off fields
    // unique to the list row.)
    expect(await screen.findByText('e-history-1')).toBeInTheDocument();
    expect(screen.getByText('emp-7')).toBeInTheDocument();
    expect(screen.getByText('seq 4')).toBeInTheDocument();

    const historyCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === `${API_BASE_URL}/events`,
    );
    expect(historyCall).toBeDefined();
    const [, init] = historyCall as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-1',
    );
    // No client-side list persistence — the session key is the only residue.
    expect(localStorage.getItem('payroll.events.tracked.v1')).toBeNull();
  });

  it('showing history for a NEW organization after a session switch requires no cleanup', async () => {
    setSession(sessionResponse());
    fetchMock.mockImplementation((url: RequestInfo | URL) =>
      String(url) === `${API_BASE_URL}/events`
        ? Promise.resolve(jsonResponse(listPage()))
        : Promise.resolve(new Response(null, { status: 204 })),
    );
    const user = userEvent.setup();

    const { unmount } = render(<App />);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === `${API_BASE_URL}/events`),
      ).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByTestId('auth-submit')).toBeInTheDocument());
    unmount();

    // A different organization signs in; its workspace is a fresh mount that
    // simply re-fetches page one with ITS session token — the previous view
    // was never stored anywhere.
    const otherSession = sessionResponse({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      user: { id: 'u-2', email: 'owner@globex.example', name: 'Grace Hopper' },
      organization: { id: 'org-2', name: 'Globex Payroll', slug: 'globex-payroll' },
    });
    setSession(otherSession);
    render(<App />);

    await waitFor(() => {
      const historyCalls = fetchMock.mock.calls.filter(
        ([url]) => String(url) === `${API_BASE_URL}/events`,
      );
      expect(historyCalls.length).toBeGreaterThanOrEqual(2);
      const [, init] = historyCalls.at(-1) as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer access-2',
      );
    });
  });
});
