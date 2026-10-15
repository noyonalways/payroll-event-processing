import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, getSession, setSession } from '../lib/session';
import type { ErrorResponseBody } from '@repo/shared';
import type { SessionResponse } from '../lib/types';
import { login, logout } from './auth';
import {
  API_BASE_URL,
  ApiError,
  NetworkError,
  SessionExpiredError,
  request,
} from './client';
import { submitEvent } from './events';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorized(): Response {
  return jsonResponse(unauthorizedBody(), 401);
}

function unauthorizedBody(): ErrorResponseBody {
  return {
    statusCode: 401,
    message: 'Unauthorized',
    error: 'UnauthorizedException',
    timestamp: '2026-08-26T00:00:00.000Z',
    path: '/events',
  };
}

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

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
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

describe('request (authenticated client)', () => {
  it('attaches the stored access token as a Bearer header', async () => {
    setSession(sessionResponse());
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(request(`${API_BASE_URL}/events/e-1`)).resolves.toEqual({
      ok: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/events/e-1`);
    expect(headersOf(init).Authorization).toBe('Bearer access-1');
  });

  it('sends no Authorization header when signed out', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await request(`${API_BASE_URL}/events/e-1`);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(headersOf(init).Authorization).toBeUndefined();
  });

  it('refreshes once on a 401 and replays the request with the rotated token', async () => {
    setSession(sessionResponse());
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(
        jsonResponse(
          sessionResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(request(`${API_BASE_URL}/events/e-1`)).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(refreshUrl).toBe(`${API_BASE_URL}/auth/refresh`);
    expect(JSON.parse(refreshInit.body as string)).toEqual({
      refreshToken: 'refresh-1',
    });

    const [retryUrl, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(retryUrl).toBe(`${API_BASE_URL}/events/e-1`);
    expect(headersOf(retryInit).Authorization).toBe('Bearer access-2');

    // The rotation was persisted, so later requests use the new pair.
    expect(getSession()).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
  });

  it('does not refresh a second time when the replay still 401s', async () => {
    setSession(sessionResponse());
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(
        jsonResponse(sessionResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' })),
      )
      .mockResolvedValueOnce(unauthorized());

    await expect(request(`${API_BASE_URL}/events/e-1`)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The refresh itself succeeded, so this 401 is about the endpoint/identity,
    // not the token — the fresh session is kept.
    expect(getSession()?.accessToken).toBe('access-2');
  });

  it('clears the session when the refresh is rejected', async () => {
    setSession(sessionResponse());
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(unauthorized());

    await expect(request(`${API_BASE_URL}/events/e-1`)).rejects.toThrow(
      'Session expired — sign in again',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // the original request is not replayed

    // The history needs no local cleanup — it is server-owned and re-scoped
    // by whatever session signs in next.
    expect(getSession()).toBeNull();
  });

  it('keeps the session when the refresh cannot reach the API', async () => {
    setSession(sessionResponse());
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(request(`${API_BASE_URL}/events/e-1`)).rejects.toBeInstanceOf(
      NetworkError,
    );

    // A network blip is not a rejected credential: the session survives so the
    // next poll can retry.
    expect(getSession()?.accessToken).toBe('access-1');
  });

  it('single-flights one refresh across concurrent 401s', async () => {
    setSession(sessionResponse());

    // Hold the refresh response open so both 401s are handled while it runs.
    let releaseRefresh: (res: Response) => void = () => {};
    const refreshGate = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    let eventCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) return refreshGate;
      eventCalls += 1;
      return Promise.resolve(
        eventCalls <= 2 ? unauthorized() : jsonResponse({ ok: true }),
      );
    });

    const first = request(`${API_BASE_URL}/events/a`);
    const second = request(`${API_BASE_URL}/events/b`);

    // Flush microtasks: both requests have hit their 401 and joined the refresh.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);

    releaseRefresh(
      jsonResponse(
        sessionResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
      ),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);

    const eventInits = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/events/'))
      .map(([, init]) => init as RequestInit);
    expect(eventInits).toHaveLength(4); // two attempts, two replays
    expect(headersOf(eventInits[0]).Authorization).toBe('Bearer access-1');
    expect(headersOf(eventInits[1]).Authorization).toBe('Bearer access-1');
    expect(headersOf(eventInits[2]).Authorization).toBe('Bearer access-2');
    expect(headersOf(eventInits[3]).Authorization).toBe('Bearer access-2');
  });

  it('fails fast with a session-expired error when signed out', async () => {
    fetchMock.mockResolvedValue(unauthorized());

    // No session to refresh from: the 401 path fails without a refresh call and
    // without replaying the request.
    await expect(request(`${API_BASE_URL}/events/e-1`)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('auth endpoints', () => {
  it('never refreshes on the auth endpoints themselves', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          statusCode: 401,
          message: 'Invalid email or password',
          error: 'UnauthorizedException',
          timestamp: '2026-08-26T00:00:00.000Z',
          path: '/auth/login',
        },
        401,
      ),
    );

    await expect(
      login({ email: 'owner@acme.example', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/login`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'owner@acme.example',
      password: 'wrong-password',
    });
  });

  it('logout resolves on the 204 with no body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(logout('refresh-1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/logout`);
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'refresh-1' });
  });
});

describe('events API wiring', () => {
  it('event submissions ride the authenticated client', async () => {
    setSession(sessionResponse());
    fetchMock.mockResolvedValue(jsonResponse({ id: 'e-2', status: 'received' }, 201));

    await submitEvent(
      {
        eventType: 'BANK_ACCOUNT_CHANGE',
        payload: {
          employeeId: 'emp-1',
          effectiveDate: '2026-09-01',
          iban: 'DE89370400440532013000',
        },
      },
      'key-42',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/events`);
    expect(headersOf(init)).toMatchObject({
      Authorization: 'Bearer access-1',
      'Idempotency-Key': 'key-42',
    });
  });
});
