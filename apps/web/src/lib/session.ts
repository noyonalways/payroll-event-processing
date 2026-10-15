import type {
  MembershipRole,
  SessionOrganization,
  SessionResponse,
  SessionUser,
} from './types';

/**
 * The signed-in session: persists it across reloads and is the app's single
 * source of truth for "am I signed in". Kept in localStorage (not
 * sessionStorage) so the session survives a reload and a reopened tab, matching
 * the tracked-event list. A write notifies subscribers, so a forced sign-out
 * (rejected refresh) flips the UI back to the sign-in view with no extra
 * plumbing.
 *
 * Reads tolerate missing or corrupt values: a bad entry is dropped, never
 * thrown, and the app falls back to the sign-in view.
 */
export const SESSION_STORAGE_KEY = 'payroll.auth.session.v1';

/**
 * The kept subset of the session response — tokens plus the identity and
 * organization the header displays. `expiresIn`/`refreshExpiresAt` are dropped:
 * the access token is refreshed reactively on a 401 rather than scheduled,
 * which needs no clock bookkeeping.
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
  organization: SessionOrganization;
  role: MembershipRole;
}

const ROLES: readonly MembershipRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

function isUser(value: unknown): value is SessionUser {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.email === 'string' &&
    (record.name === null || typeof record.name === 'string')
  );
}

function isOrganization(value: unknown): value is SessionOrganization {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.slug === 'string'
  );
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === 'string' &&
    typeof record.refreshToken === 'string' &&
    typeof record.role === 'string' &&
    (ROLES as readonly string[]).includes(record.role) &&
    isUser(record.user) &&
    isOrganization(record.organization)
  );
}

// In-memory cache: a signed-in session is a stable reference between writes, so
// `useSyncExternalStore` sees a new snapshot only when the session changes. When
// signed out the cache is empty and every read falls through to storage.
let cached: StoredSession | null = null;
const listeners = new Set<() => void>();

function readStorage(): StoredSession | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Current session, restored from storage on first read after a write. */
export function getSession(): StoredSession | null {
  if (cached === null) cached = readStorage();
  return cached;
}

/** Persist a fresh session response (login/register/refresh rotation). */
export function setSession(session: SessionResponse): void {
  cached = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user: session.user,
    organization: session.organization,
    role: session.role,
  };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(cached));
    } catch {
      // quota exceeded or storage blocked — the in-memory session still works.
    }
  }
  notify();
}

/** Drop the session; subscribers are notified so the UI returns to sign-in. */
export function clearSession(): void {
  cached = null;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // best effort; the in-memory session is already cleared.
    }
  }
  notify();
}

/** Subscribe to session changes (sign-in, rotation, sign-out). */
export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
