import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL } from '../api/client';
import type { SessionResponse } from '../lib/types';
import { AuthView } from './AuthView';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

function errorBody(message: string, statusCode: number, path: string): unknown {
  return {
    statusCode,
    message,
    error: statusCode === 409 ? 'ConflictException' : 'UnauthorizedException',
    timestamp: '2026-08-26T00:00:00.000Z',
    path,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillSignIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/email/i), 'owner@acme.example');
  await user.type(screen.getByLabelText(/password/i), 'correct-horse-battery');
}

describe('AuthView', () => {
  it('renders the sign-in form by default, without the registration fields', () => {
    render(<AuthView onAuthenticated={vi.fn()} />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/organization name/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument();
  });

  it('signs in and hands the session to onAuthenticated', async () => {
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(sessionResponse()));
    render(<AuthView onAuthenticated={onAuthenticated} />);

    await fillSignIn(user);
    await user.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(onAuthenticated).toHaveBeenCalledWith(sessionResponse());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/login`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'owner@acme.example',
      password: 'correct-horse-battery',
    });
  });

  it('registers a new organization and signs in as its owner', async () => {
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(sessionResponse(), 201));
    render(<AuthView onAuthenticated={onAuthenticated} />);

    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/organization name/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/your name/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/organization name/i), 'Acme Payroll');
    await fillSignIn(user);
    await user.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/register`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'owner@acme.example',
      password: 'correct-horse-battery',
      name: 'Ada Lovelace',
      organizationName: 'Acme Payroll',
    });
  });

  it('omits a blank optional name on registration', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(sessionResponse(), 201));
    render(<AuthView onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Register' }));
    await user.type(screen.getByLabelText(/organization name/i), 'Acme Payroll');
    await fillSignIn(user);
    await user.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('name');
  });

  it('surfaces a failed sign-in without clearing the typed values', async () => {
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(
        errorBody('Invalid email or password', 401, '/auth/login'),
        401,
      ),
    );
    render(<AuthView onAuthenticated={onAuthenticated} />);

    await fillSignIn(user);
    await user.click(screen.getByTestId('auth-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid email or password',
    );
    expect(screen.getByLabelText(/email/i)).toHaveValue('owner@acme.example');
    expect(screen.getByLabelText(/password/i)).toHaveValue('correct-horse-battery');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('surfaces a registration conflict (email already used)', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(
        errorBody(
          'An account with this email already exists',
          409,
          '/auth/register',
        ),
        409,
      ),
    );
    render(<AuthView onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Register' }));
    await user.type(screen.getByLabelText(/organization name/i), 'Acme Payroll');
    await fillSignIn(user);
    await user.click(screen.getByTestId('auth-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists',
    );
  });
});
