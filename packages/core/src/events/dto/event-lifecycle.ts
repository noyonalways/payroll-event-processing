/**
 * The wire vocabulary of the payroll event lifecycle (shared by the list,
 * status, and recovery-action DTOs so every contract agrees on the states and
 * their casing): the lowercase values GET /events/{id} has always served, which
 * are also the values the `status` filter on GET /events accepts.
 *
 * `cancelled` is the manual terminal state (event-recovery): reachable only
 * from the pending states (received/queued) by a recovery action.
 *
 * Since realtime-status the canonical home of the vocabulary is `@repo/shared`
 * — the event-status-stream notifications carry the same values — and this
 * module re-exports it so the API boundary keeps one import site.
 *
 * Storage keeps the Prisma `EventStatus` enum (UPPERCASE); the mapping happens
 * at the API boundary.
 */
export {
  EVENT_LIFECYCLE_STATUSES,
  type EventLifecycleStatus,
} from '@repo/shared';
