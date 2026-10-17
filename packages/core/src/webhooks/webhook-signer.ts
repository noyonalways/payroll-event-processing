import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Webhook signing (integrator-webhooks design D4). HMAC-SHA256 over the EXACT
 * raw bytes transmitted — consumers verify by hashing the request body bytes
 * with their endpoint's secret and comparing digests. The raw body is always a
 * Buffer in the relay, so signature and transmitted bytes cannot drift.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Payroll-Signature';
export const WEBHOOK_DELIVERY_HEADER = 'X-Payroll-Delivery';
export const WEBHOOK_EVENT_HEADER = 'X-Payroll-Event';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Payroll-Timestamp';
export const WEBHOOK_SIGNATURE_PREFIX = 'sha256=';

/** Generates a new endpoint signing secret: 32 random bytes, base64. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Signs raw request bytes: `sha256=<hex hmac-sha256(raw bytes, secret)>`.
 * Hex is lowercase for unambiguous string comparison by consumers.
 */
export function signWebhookBody(rawBody: Buffer, secret: string): string {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  return WEBHOOK_SIGNATURE_PREFIX + digest;
}

/**
 * Constant-time digest comparison — available to tests and any future
 * consumer-side verification helper. Expects the full header value
 * (`sha256=<hex>`).
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  secret: string,
  header: string,
): boolean {
  const expected = signWebhookBody(rawBody, secret);
  if (header.length !== expected.length) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return timingSafeEqual(a, b);
}
