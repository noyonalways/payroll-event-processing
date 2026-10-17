/**
 * Metadata key for `@Public()` — read by the global `JwtAuthGuard` to skip
 * authentication for a route (or a whole controller).
 */
export const IS_PUBLIC_KEY = 'auth:is-public';

/**
 * Metadata key for `@Roles()` — read by the global `RolesGuard` to enforce a
 * route's minimum membership role (role-enforcement design D1). A route with
 * no metadata stays open to any authenticated actor; the JWT guard still
 * applies (authentication precedes authorization, 401 beats 403).
 */
export const ROLES_KEY = 'auth:min-roles';

/** Access tokens are short-lived; a refresh token mints the next one. */
export const ACCESS_TOKEN_TYPE = 'access' as const;

/** Bearer scheme prefix on the `Authorization` header. */
export const BEARER_PREFIX = 'Bearer ';

/** Name of the request property the guard attaches the resolved actor to. */
export const REQUEST_ACTOR_KEY = 'actor';

/**
 * The membership-role hierarchy (role-enforcement design D2): the rank orders
 * the three roles so `@Roles(ADMIN)` means "ADMIN or higher" — an OWNER
 * implicitly satisfies every gate a lower role declares. A rank of `0` is the
 * unauthenticated floor nobody holds, which keeps the comparison
 * fail-closed for malformed actors.
 */
export const ROLE_RANK: Record<string, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

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
