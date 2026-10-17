import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { API_BASE_URL } from './api/client';
import { clearSession, getSession, setSession } from './lib/session';
import type { Employee, EventListItem, SessionResponse } from './lib/types';

function sessionResponse(overrides: Partial<SessionResponse> = {}): SessionResponse {
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
  nextCursor: null;
  limit: number;
} {
  return { data, nextCursor: null, limit: 100 };
}

function listRow(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    eventType: 'SALARY_CHANGE',
    employeeId: 'EMP-001',
    sequence: 4,
    status: 'success',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:01.000Z',
    processedAt: '2026-08-26T00:00:01.000Z',
    id,
    ...overrides,
  };
}

const employee = (overrides: Partial<Employee> = {}): Employee => ({
  id: 'emp-row-1',
  employeeNumber: 'EMP-001',
  name: 'Jane Doe',
  department: 'Engineering',
  active: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

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

/** The dashboard home fetches events + employees. */
function mockDashboardHome(
  events: EventListItem[] = [],
  employees: Employee[] = [],
): void {
  fetchMock.mockImplementation((url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/employees')) {
      return Promise.resolve(
        jsonResponse({ data: employees, nextCursor: null, limit: 100 }),
      );
    }
    if (u.includes('/events')) {
      return Promise.resolve(jsonResponse(listPage(events)));
    }
    return Promise.resolve(jsonResponse(listPage()));
  });
}

describe('App session gate', () => {
  it('shows the sign-in view when there is no session', () => {
    render(<App />);

    expect(screen.getByTestId('auth-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view')).not.toBeInTheDocument();
  });

  it('with a session, shows the dashboard acting in the organization', async () => {
    setSession(sessionResponse());
    mockDashboardHome([listRow('e-1')], [employee()]);

    render(<App />);

    expect(await screen.findByTestId('dashboard-view')).toBeInTheDocument();
    expect(screen.getByText(/acting in/i)).toBeInTheDocument();
    expect(screen.getByText('Acme Payroll')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-email').textContent).toContain('owner@acme.example');
  });

  it('returns to sign-in when every authenticated call is rejected and cannot refresh', async () => {
    setSession(sessionResponse());
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 401,
          message: 'Unauthorized',
          error: 'UnauthorizedException',
          timestamp: '2026-08-26T00:00:00.000Z',
          path: '/events',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByTestId('auth-submit')).toBeInTheDocument());
    expect(getSession()).toBeNull();
  });

  it('sign-out revokes the token, clears the session, and returns to sign-in', async () => {
    const user = userEvent.setup();
    setSession(sessionResponse());
    mockDashboardHome();

    render(<App />);
    await screen.findByTestId('dashboard-view');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(getSession()).toBeNull());
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('auth-submit')).toBeInTheDocument();

    const logoutCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/auth/logout'),
    );
    expect(logoutCall).toBeDefined();
    const [url, init] = logoutCall as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/logout`);
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'refresh-1' });
  });
});

describe('App workspace (new IA)', () => {
  it('the dashboard renders stats, needs-attention retries, and latest activity from the server', async () => {
    const user = userEvent.setup();
    setSession(sessionResponse());
    const failed = listRow('e-failed-1', {
      id: 'e-failed-1',
      status: 'failed',
      eventType: 'SALARY_CHANGE',
    });
    mockDashboardHome([failed, listRow('e-ok-1')], [employee()]);

    render(<App />);
    await screen.findByTestId('dashboard-view');

    expect(screen.getByTestId('stat-applied')).toHaveTextContent('1');
    expect(screen.getByTestId('stat-failed')).toHaveTextContent('1');
    expect(await screen.findByTestId('dashboard-failed-e-failed-1')).toBeInTheDocument();

    await user.click(screen.getByTestId('dashboard-retry-e-failed-1'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === `${API_BASE_URL}/events/e-failed-1/retry`,
        ),
      ).toBe(true),
    );
  });

  it('the change-requests view shows human rows and drives retry', async () => {
    const user = userEvent.setup();
    setSession(sessionResponse());
    mockDashboardHome(
      [
        listRow('e-1', { status: 'failed', eventType: 'BANK_ACCOUNT_CHANGE' }),
        listRow('e-2', { status: 'success' }),
      ],
      [employee()],
    );

    render(<App />);
    await screen.findByTestId('dashboard-view');

    await user.click(screen.getByTestId('view-requests'));

    expect(await screen.findByTestId('requests-view')).toBeInTheDocument();
    expect(screen.getAllByText('Jane Doe').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bank account change').length).toBeGreaterThan(0);
    expect(screen.getByTestId('requests-filter-failed')).toBeInTheDocument();

    const retryBtn = await screen.findByTestId('request-retry-e-1');
    await user.click(retryBtn);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url).endsWith('/events/e-1/retry'),
        ),
      ).toBe(true),
    );
  });

  it('opens the wizard from the dashboard and submits a typed request', async () => {
    const user = userEvent.setup();
    setSession(sessionResponse());
    let postCall: { url: string; body: { eventType: string; payload: Record<string, unknown> } } | null = null;
    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === `${API_BASE_URL}/events` && init?.method === 'POST') {
        postCall = {
          url: u,
          body: JSON.parse((init as RequestInit).body as string),
        };
        return Promise.resolve(jsonResponse({ id: 'e-new', status: 'received' }, 201));
      }
      if (u.includes('/employees')) {
        return Promise.resolve(
          jsonResponse({ data: [employee()], nextCursor: null, limit: 100 }),
        );
      }
      if (u.includes('/events')) {
        return Promise.resolve(jsonResponse(listPage()));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<App />);
    await screen.findByTestId('dashboard-view');
    await user.click(screen.getByTestId('dashboard-request-change'));

    await waitFor(() => expect(screen.getByTestId('wizard-search')).toBeInTheDocument());
    await user.click(screen.getByTestId('wizard-person-EMP-001'));
    await user.click(screen.getByTestId('wizard-next'));

    await user.click(screen.getByTestId('wizard-kind-SALARY_CHANGE'));
    await user.click(screen.getByTestId('wizard-next'));

    await user.type(screen.getByTestId('wizard-field-newSalary'), '75000');
    await user.type(screen.getByTestId('wizard-field-currency'), 'EUR');
    await user.type(screen.getByTestId('wizard-effective-date'), '2026-11-01');
    await user.click(screen.getByTestId('wizard-details-next'));

    expect(screen.getByTestId('wizard-review').textContent).toContain('Jane Doe');
    expect(screen.getByTestId('wizard-review').textContent).toContain('75,000');
    await user.click(screen.getByTestId('wizard-submit'));

    await waitFor(() => expect(postCall).toBeTruthy());
    expect(postCall!.body.eventType).toBe('SALARY_CHANGE');
    expect(postCall!.body.payload).toMatchObject({
      employeeId: 'EMP-001',
      newSalary: '75000',
      currency: 'EUR',
      effectiveDate: '2026-11-01',
    });
  });

  it('the People view shows the roster, applied state, and prefill hand-off', async () => {
    const user = userEvent.setup();
    setSession(sessionResponse());
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/employees')) {
        return Promise.resolve(
          jsonResponse({ data: [employee()], nextCursor: null, limit: 100 }),
        );
      }
      if (u.match(/\/events\/[^/?]+$/)) {
        return Promise.resolve(
          jsonResponse({
            id: 'e-1',
            eventType: 'SALARY_CHANGE',
            employeeId: 'EMP-001',
            sequence: 1,
            status: 'success',
            payload: {
              employeeId: 'EMP-001',
              effectiveDate: '2026-09-01',
              newSalary: 75000,
              currency: 'EUR',
            },
            createdAt: '2026-08-26T00:00:00.000Z',
            updatedAt: '2026-08-26T00:00:01.000Z',
            processedAt: '2026-08-26T00:00:01.000Z',
            result: {
              reference: 'SIM-1',
              acknowledged: { newSalary: 75000, currency: 'EUR', effectiveDate: '2026-09-01' },
            },
            attempts: [],
          }),
        );
      }
      if (u.includes('/events')) {
        return Promise.resolve(
          jsonResponse(listPage([listRow('e-1', { employeeId: 'EMP-001', status: 'success' })])),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<App />);
    await screen.findByTestId('dashboard-view');
    await user.click(screen.getByTestId('view-people'));

    expect(await screen.findByTestId('people-row-EMP-001')).toBeInTheDocument();
    await user.click(screen.getByTestId('people-row-EMP-001'));

    await waitFor(() =>
      expect(screen.getByTestId('person-current').textContent).toContain('75,000'),
    );

    await user.click(screen.getByTestId('person-request-change'));
    expect(screen.getByTestId('request-change-view')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('wizard-person-EMP-001').textContent).toContain('Jane Doe'),
    );
  });

  it('the Provider tab is hidden for non-OWNER members', async () => {
    setSession(sessionResponse({ role: 'MEMBER' }));
    mockDashboardHome();

    render(<App />);
    await screen.findByTestId('dashboard-view');

    expect(screen.queryByTestId('view-provider')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-members')).toBeInTheDocument();
    expect(screen.getByTestId('view-webhooks')).toBeInTheDocument();
  });
});
