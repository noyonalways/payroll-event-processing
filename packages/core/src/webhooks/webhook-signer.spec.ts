import {
  signWebhookBody,
  verifyWebhookSignature,
  generateWebhookSecret,
  WEBHOOK_SIGNATURE_PREFIX,
} from './webhook-signer';

/**
 * Signing contract (integrator-webhooks design D4): HMAC-SHA256 over the exact
 * raw bytes with the endpoint secret, `sha256=<hex>`. Fixed vectors pin the
 * algorithm so consumers can implement verification independently.
 */
describe('webhook-signer', () => {
  // Known vector: HMAC-SHA256("webhook body", "secret-1")
  const RAW = Buffer.from('webhook body', 'utf8');
  const SECRET = 'secret-1';
  // `HMAC_SHA256(key=secret-1, msg=utf8("webhook body"))` in lowercase hex.
  const EXPECTED_DIGEST = '874f5daa3b28899d5aafd095a3f707e846371bf4a193e8a73d32f424ab18e629';

  it('signs raw bytes with a fixed known vector', () => {
    expect(signWebhookBody(RAW, SECRET)).toBe(WEBHOOK_SIGNATURE_PREFIX + EXPECTED_DIGEST);
  });

  it('generates 32-byte base64 secrets', () => {
    const secret = generateWebhookSecret();
    expect(Buffer.from(secret, 'base64').byteLength).toBe(32);
    expect(generateWebhookSecret()).not.toEqual(secret);
  });

  it('verifies a correct signature (constant-time path)', () => {
    const header = signWebhookBody(RAW, SECRET);
    expect(verifyWebhookSignature(RAW, SECRET, header)).toBe(true);
  });

  it('rejects a body tampered after signing', () => {
    const header = signWebhookBody(RAW, SECRET);
    expect(verifyWebhookSignature(Buffer.from('tampered body'), SECRET, header)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const header = signWebhookBody(RAW, 'secret-2');
    expect(verifyWebhookSignature(RAW, SECRET, header)).toBe(false);
  });

  it('rejects truncated or malformed header values', () => {
    const header = signWebhookBody(RAW, SECRET);
    expect(verifyWebhookSignature(RAW, SECRET, header.slice(0, 10))).toBe(false);
    expect(verifyWebhookSignature(RAW, SECRET, 'not-a-signature')).toBe(false);
  });
});
