import { useSyncExternalStore } from 'react';

import { getSession, subscribeToSession } from './session';
import type { StoredSession } from './session';

/**
 * Reactive view of the session store. Returns the current session (or null)
 * and re-renders the subscriber on every change — sign-in, token rotation, and
 * forced sign-out all flow through the same subscription.
 */
export function useSession(): StoredSession | null {
  return useSyncExternalStore(subscribeToSession, getSession);
}
