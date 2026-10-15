import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_STORAGE_KEY,
  clearSession,
  getSession,
  setSession,
  subscribeToSession,
} from './session';
import type { SessionResponse } from './types';

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

beforeEach(() => {
  localStorage.clear();
  clearSession();
});

describe('session storage', () => {
  it('persists a session and reads it back with a stable reference', () => {
    setSession(sessionResponse());

    const session = getSession();
    expect(session).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      role: 'OWNER',
      user: { email: 'owner@acme.example' },
      organization: { name: 'Acme Payroll' },
    });
    // Reference stability matters: useSyncExternalStore re-renders on identity
    // change, so repeated reads must not build a new object.
    expect(getSession()).toBe(session);

    const raw = JSON.parse(
      localStorage.getItem(SESSION_STORAGE_KEY) ?? 'null',
    ) as unknown;
    expect(raw).toMatchObject({ accessToken: 'access-1' });
  });

  it('restores a session persisted by a previous page load', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionResponse()));

    expect(getSession()).toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('tolerates missing, corrupt, or wrongly shaped storage', () => {
    expect(getSession()).toBeNull();

    localStorage.setItem(SESSION_STORAGE_KEY, 'not json {');
    expect(getSession()).toBeNull();

    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: 'only-a-token' }),
    );
    expect(getSession()).toBeNull();
  });

  it('clearSession drops storage, the read value, and notifies subscribers', () => {
    setSession(sessionResponse());
    const listener = vi.fn();
    const unsubscribe = subscribeToSession(listener);

    clearSession();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSession()).toBeNull();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();

    // Unsubscribing stops further notifications.
    unsubscribe();
    setSession(sessionResponse());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when a session is written', () => {
    const listener = vi.fn();
    subscribeToSession(listener);

    setSession(sessionResponse());

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSession()?.accessToken).toBe('access-1');
  });
});
