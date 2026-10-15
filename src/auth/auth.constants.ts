/**
 * Metadata key for `@Public()` — read by the global `JwtAuthGuard` to skip
 * authentication for a route (or a whole controller).
 */
export const IS_PUBLIC_KEY = 'auth:is-public';

/** Access tokens are short-lived; a refresh token mints the next one. */
export const ACCESS_TOKEN_TYPE = 'access' as const;

/** Bearer scheme prefix on the `Authorization` header. */
export const BEARER_PREFIX = 'Bearer ';

/** Name of the request property the guard attaches the resolved actor to. */
export const REQUEST_ACTOR_KEY = 'actor';

export const AUTH_DEFAULT_ACCESS_TTL = '15m';
export const AUTH_DEFAULT_REFRESH_TTL_DAYS = 30;

/** scrypt parameters (design D6). */
export const SCRYPT_PARAMS = {
  /** CPU/memory cost — 2^15. OWASP's recommended scrypt floor with r=8. */
  N: 32768,
  blockSize: 8,
  parallelization: 1,
  keyLength: 32,
  saltBytes: 16,
  /**
   * scrypt needs 128 * N * r bytes; the Node default (32 MiB) is BELOW what
   * N=32768/r=8 requires, so the limit is raised explicitly. Doubling leaves
   * headroom for the internal working buffer.
   */
  maxmem: 128 * 32768 * 8 * 2,
} as const;
