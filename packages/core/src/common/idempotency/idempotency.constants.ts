/**
 * Shared idempotency-layer constants: the OpenAPI header definition, the key
 * contract, and registered scope names. Single source of truth for both the
 * runtime decorator and the Swagger docs so they can never drift.
 */
export const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description:
    'Client-generated key uniquely identifying this submission. Re-submitting ' +
    'with the same key returns the stored response instead of creating a duplicate operation.',
  example: 'b2f7e3d8-9a1c-4e5f-8c2b-1a0d9e8f7c6b',
} as const;

export const IDEMPOTENCY_SCOPE_EVENT_SUBMISSION = 'event-submission';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Printable ASCII: space (0x20) through tilde (0x7E). */
export const IDEMPOTENCY_KEY_PRINTABLE_ASCII = /^[\x20-\x7E]+$/;