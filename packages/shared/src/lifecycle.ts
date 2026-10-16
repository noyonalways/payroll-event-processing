/**
 * The wire vocabulary of the payroll event lifecycle — the lowercase values
 * every contract agrees on: the status fields of the REST DTOs (status, list,
 * recovery actions), the `status` filter of GET /events, and (since
 * realtime-status) the `status` field of event-status-stream notifications.
 *
 * `cancelled` is the manual terminal state (event-recovery): reachable only
 * from the pending states (received/queued) by a recovery action.
 *
 * This is the shared home of the vocabulary (realtime-status task 1.1);
 * `@repo/core`'s `event-lifecycle.ts` re-exports it so the API boundary keeps
 * one import site. Storage keeps the Prisma `EventStatus` enum (UPPERCASE);
 * the mapping happens at the API boundary.
 */
export const EVENT_LIFECYCLE_STATUSES = [
  'received',
  'queued',
  'processing',
  'success',
  'failed',
  'cancelled',
] as const;

export type EventLifecycleStatus = (typeof EVENT_LIFECYCLE_STATUSES)[number];
