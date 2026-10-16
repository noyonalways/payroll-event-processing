/**
 * Identifiers of the event-status-stream (realtime-status). Shared by the API
 * (subscriber), the worker (publisher), and indirectly the browser (which
 * learns the contract through its own types) so both processes agree on one
 * pub/sub topic colocated with the BullMQ queue's Redis usage (design D1).
 */

/**
 * The single Redis pub/sub topic carrying committed lifecycle transitions.
 * Messages are JSON `EventStatusNotification` bodies; the carrying payload's
 * `organizationId` scopes delivery — the API filters by it in-process (D1/D5).
 */
export const EVENT_STATUS_STREAM_CHANNEL = 'payroll-event-status';
