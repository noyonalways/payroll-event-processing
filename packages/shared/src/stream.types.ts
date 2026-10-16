import { EventType } from './event-type';
import type { EventLifecycleStatus } from './lifecycle';

/**
 * One committed lifecycle transition on the event-status-stream (design D2) —
 * the JSON `data` frame of the SSE endpoint and the pub/sub message body the
 * publisher writes between the worker and API processes.
 *
 * `status` is the NEWLY COMMITTED state: an attempt whose claim was rolled
 * back (transient retry) is never announced as `processing`, because nothing
 * was committed (spec: "the stream SHALL reflect only committed state").
 */
export interface EventStatusNotification {
  /** Tenant the event belongs to — the dispatch/defense filter of D1. */
  organizationId: string;
  /** `payroll_events.id`. */
  eventId: string;
  eventType: EventType;
  employeeId: string;
  /** JSON-safe sequence (Number(bigint)) — the queue job data convention. */
  sequence: number;
  /** The transition's newly committed state. */
  status: EventLifecycleStatus;
  /** ISO-8601 commit time of the announcing transition. */
  occurredAt: string;
}
