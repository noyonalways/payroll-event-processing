/**
 * The wire vocabulary of the payroll event lifecycle (shared by the list and
 * status DTOs so both contracts can never disagree on the states or their
 * casing): the lowercase values GET /events/{id} has always served, which are
 * also the values the `status` filter on GET /events accepts.
 *
 * Storage keeps the Prisma `EventStatus` enum (UPPERCASE); the mapping happens
 * at the API boundary.
 */
export const EVENT_LIFECYCLE_STATUSES = [
  'received',
  'queued',
  'processing',
  'success',
  'failed',
] as const;

export type EventLifecycleStatus = (typeof EVENT_LIFECYCLE_STATUSES)[number];
