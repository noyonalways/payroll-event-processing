import { useCallback, useEffect, useReducer, useRef } from 'react';

import { fetchEventStatus } from '../api/events';
import type { EventType, LifecycleStatus } from './types';
import { isTerminal } from './status';
import {
  clearTrackedEvents,
  loadTrackedEvents,
  saveTrackedEvents,
} from './storage';
import type { TrackedEvent } from './storage';

/** Fixed polling interval for non-terminal tracked events. */
export const POLL_INTERVAL_MS = 3000;

type TrackerState = {
  entries: TrackedEvent[];
};

type TrackerAction =
  | { type: 'restore'; events: TrackedEvent[] }
  | { type: 'record'; event: TrackedEvent }
  | { type: 'polled'; id: string; status: LifecycleStatus; sequence: number; attempts: number }
  | { type: 'pollFailed'; id: string; error: string }
  | { type: 'clear' };

function reducer(state: TrackerState, action: TrackerAction): TrackerState {
  switch (action.type) {
    case 'restore':
      return { entries: action.events };
    case 'clear':
      return { entries: [] };
    case 'record':
      if (state.entries.some((entry) => entry.id === action.event.id)) {
        return state;
      }
      return { entries: [...state.entries, action.event] };
    case 'polled': {
      const target = state.entries.find((entry) => entry.id === action.id);
      if (!target) return state;
      return {
        entries: state.entries.map((entry) =>
          entry.id === action.id
            ? {
                ...entry,
                lastStatus: action.status,
                sequence: action.sequence,
                attempts: action.attempts,
                error: undefined,
              }
            : entry,
        ),
      };
    }
    case 'pollFailed': {
      const target = state.entries.find((entry) => entry.id === action.id);
      if (!target) return state;
      return {
        entries: state.entries.map((entry) =>
          entry.id === action.id ? { ...entry, error: action.error } : entry,
        ),
      };
    }
  }
}

export interface RecordSubmissionInput {
  id: string;
  eventType: EventType;
  employeeId: string;
  idempotencyKey: string;
  submittedAt?: string;
}

export interface UseEventTrackerResult {
  entries: TrackedEvent[];
  recordSubmission: (input: RecordSubmissionInput) => void;
  clearList: () => void;
}

/**
 * Owns the tracked event list and live-polls `GET /events/{id}` for every
 * non-terminal entry every `POLL_INTERVAL_MS`. Polls run concurrently via
 * `Promise.allSettled` and are isolated per row: a failing row is marked
 * `unavailable` while the rest of the list keeps polling (and retries it on
 * later ticks, so the list self-heals once the API is reachable again).
 * Terminal events (`success`/`failed`) are excluded from subsequent polls.
 */
export function useEventTracker(): UseEventTrackerResult {
  const [state, dispatch] = useReducer(reducer, { entries: [] });
  // Latest-state ref so the single interval created on mount always reads the
  // current list without re-creating the timer on every state change.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Restore the persisted list once on mount; resume polling for it.
  useEffect(() => {
    dispatch({ type: 'restore', events: loadTrackedEvents() });
  }, []);

  const startedRef = useRef(false);

  // Persist on every change, except the initial mount before restore lands.
  // An empty list drops the storage key entirely (the "Clear list" action).
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      return;
    }
    if (state.entries.length === 0) {
      clearTrackedEvents();
    } else {
      saveTrackedEvents(state.entries);
    }
  }, [state.entries]);

  useEffect(() => {
    const timer = setInterval(() => {
      const { entries } = stateRef.current;
      const targets = entries.filter((entry) => !isTerminal(entry.lastStatus));
      if (targets.length === 0) return;

      // Each row fails or succeeds independently — no row blocks the others.
      void Promise.allSettled(
        targets.map((entry) =>
          fetchEventStatus(entry.id).then(
            (res) =>
              dispatch({
                type: 'polled',
                id: res.id,
                status: res.status,
                sequence: res.sequence,
                attempts: res.attempts.length,
              }),
            (error: unknown) =>
              dispatch({
                type: 'pollFailed',
                id: entry.id,
                error:
                  error instanceof Error ? error.message : 'Status poll failed',
              }),
          ),
        ),
      );
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  const recordSubmission = useCallback((input: RecordSubmissionInput) => {
    const event: TrackedEvent = {
      id: input.id,
      eventType: input.eventType,
      employeeId: input.employeeId,
      lastStatus: 'received',
      attempts: 0,
      sequence: undefined,
      submittedAt: input.submittedAt ?? new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
    };
    dispatch({ type: 'record', event });
  }, []);

  const clearList = useCallback(() => {
    dispatch({ type: 'clear' });
    clearTrackedEvents();
  }, []);

  return { entries: state.entries, recordSubmission, clearList };
}