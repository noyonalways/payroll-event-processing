import { EVENT_TYPES } from './types';
import type { EventType, LifecycleStatus } from './types';

/**
 * Storage for the browser-local tracked event list. There is no `GET /events`
 * list endpoint (roadmap change #8 owns it), so the frontend persists what it
 * has submitted and resumes polling from it — a reload mid-lifecycle never
 * loses an event from the UI.
 *
 * Reads tolerate missing or corrupt values: a bad entry is dropped, never
 * thrown, so the tracker keeps working.
 */
export const TRACKED_EVENTS_STORAGE_KEY = 'payroll.events.tracked.v1';

/** One row in the tracked list (client state, not a backend shape). */
export interface TrackedEvent {
  id: string;
  eventType: EventType;
  employeeId: string;
  /** Last lifecycle status observed from GET /events/{id}. */
  lastStatus: LifecycleStatus;
  /** Recorded attempt count (length of the attempt trail at last poll). */
  attempts: number;
  /** Per-employee sequence; unknown until the first successful poll. */
  sequence?: number;
  /** ISO timestamp of the client-side submission. */
  submittedAt: string;
  idempotencyKey: string;
  /** Set when the last poll failed (network error or 404) → row is Unavailable. */
  error?: string;
}

const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  'received',
  'queued',
  'processing',
  'success',
  'failed',
];

function isTrackedEvent(value: unknown): value is TrackedEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.eventType !== 'string' ||
    !(EVENT_TYPES as readonly string[]).includes(record.eventType) ||
    typeof record.employeeId !== 'string' ||
    typeof record.lastStatus !== 'string' ||
    !(LIFECYCLE_STATUSES as readonly string[]).includes(record.lastStatus) ||
    typeof record.attempts !== 'number' ||
    typeof record.submittedAt !== 'string' ||
    typeof record.idempotencyKey !== 'string'
  ) {
    return false;
  }
  if (
    ('sequence' in record &&
      record.sequence !== undefined &&
      typeof record.sequence !== 'number') ||
    ('error' in record &&
      record.error !== undefined &&
      typeof record.error !== 'string')
  ) {
    return false;
  }
  return true;
}

/** Read the tracked list; returns [] when missing, corrupt, or unreadable. */
export function loadTrackedEvents(): TrackedEvent[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TRACKED_EVENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTrackedEvent);
  } catch {
    return [];
  }
}

/** Persist the whole tracked list. Failures are swallowed — memory keeps working. */
export function saveTrackedEvents(events: TrackedEvent[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TRACKED_EVENTS_STORAGE_KEY, JSON.stringify(events));
  } catch {
    // quota exceeded or storage blocked — the in-memory list is unaffected.
  }
}

export function clearTrackedEvents(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(TRACKED_EVENTS_STORAGE_KEY);
  } catch {
    // best effort; the in-memory list is cleared by the reducer.
  }
}