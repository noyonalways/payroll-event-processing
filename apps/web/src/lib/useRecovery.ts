import { useCallback, useRef, useState } from 'react';

import { cancelEvent, retryEvent } from '../api/events';

/** The two manual recovery actions the UI offers on a history row. */
export type RecoveryAction = 'retry' | 'cancel';

/**
 * The structured error of a REJECTED recovery action (a 409 from a lifecycle
 * guard or a 401), surfaced next to the list without changing the row.
 */
export interface RecoveryError {
  action: RecoveryAction;
  eventId: string;
  message: string;
  statusCode: number;
}

export interface UseRecoveryOptions {
  /**
   * Called after EVERY settled action — success or rejection — before the
   * hook returns. A successful retry/cancel changes committed SERVER state,
   * so the list re-fetches page one (a retried row returns to `queued` and
   * re-enters the poll cadence; a cancelled row reads terminal); a rejection
   * re-fetches so the row's badge reflects the lifecycle that changed
   * underneath the user (the 409 case).
   */
  onSettled: () => void | Promise<void>;
}

const messageOf = (error: unknown): { message: string; statusCode: number } => {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const e = error as { statusCode: number; message?: unknown };
    const raw = e.message;
    const message = Array.isArray(raw) ? raw.join('; ') : String(raw ?? 'Action rejected');
    return { message, statusCode: e.statusCode };
  }
  return { message: error instanceof Error ? error.message : 'Request failed', statusCode: 0 };
};

/**
 * Manual recovery over the visible history rows (event-recovery, frontend-app
 * delta "Recovery actions confirm, then update the row in place"): each action
 * asks for confirmation, calls the corresponding endpoint with the session's
 * token (the client attaches it; no Idempotency-Key header — the transition
 * guard answers an already-applied action with 409), and reports the outcome.
 *
 * The hook does NOT mutate rows itself: committed lifecycle state is the
 * server's, so every settled action funnels into `onSettled` (the history's
 * `refresh()`), which is also what puts a retried row back into the poll
 * cadence and shows the badge of a row that raced the action.
 */
export function useRecovery({ onSettled }: UseRecoveryOptions) {
  const [pendingAction, setPendingAction] = useState<{
    action: RecoveryAction;
    eventId: string;
  } | null>(null);
  const [error, setError] = useState<RecoveryError | null>(null);

  // Identity of the "confirm?" dialog vote for the in-flight action: stale
  // double-clicks while a request is pending are ignored, not queued.
  const inFlight = useRef(false);

  const apply = useCallback(
    async (action: RecoveryAction, eventId: string): Promise<boolean> => {
      if (inFlight.current) return false;
      const question =
        action === 'retry'
          ? `Retry event ${eventId}? It will be processed again.`
          : `Cancel event ${eventId}? A cancelled event is never processed.`;
      if (!window.confirm(question)) return false;

      inFlight.current = true;
      setPendingAction({ action, eventId });
      setError(null);
      try {
        if (action === 'retry') await retryEvent(eventId);
        else await cancelEvent(eventId);
        return true;
      } catch (requestError: unknown) {
        const { message, statusCode } = messageOf(requestError);
        setError({ action, eventId, message, statusCode });
        return false;
      } finally {
        inFlight.current = false;
        setPendingAction(null);
        // Both outcomes re-sync the list from the server (see UseRecoveryOptions).
        void onSettled();
      }
    },
    [onSettled],
  );

  const retry = useCallback((eventId: string) => apply('retry', eventId), [apply]);
  const cancel = useCallback((eventId: string) => apply('cancel', eventId), [apply]);
  const clearError = useCallback(() => setError(null), []);

  return { retry, cancel, pendingAction, error, clearError };
}
