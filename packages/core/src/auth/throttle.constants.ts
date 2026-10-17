/**
 * Throttle profiles (auth-hardening design D3). Read with the codebase's
 * established precedence — `real process.env` > defaults — at module-import
 * time, mirroring `FailureConfig.fromEnv` (which had the same ConfigService
 * snapshot limitation).
 */
const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Strict profile for the unauthenticated credential surface (per client IP). */
export const AUTH_THROTTLE = {
  limit: toInt(process.env.AUTH_THROTTLE_LIMIT, 5),
  ttlMs: toInt(process.env.AUTH_THROTTLE_TTL_SECONDS, 60) * 1000,
};

export const DEFAULT_THROTTLE = {
  limit: toInt(process.env.DEFAULT_THROTTLE_LIMIT, 100),
  ttlMs: toInt(process.env.DEFAULT_THROTTLE_TTL_SECONDS, 60) * 1000,
};

/** Routes that MUST never be throttled: liveness + scrapes. */
export const THROTTLE_EXEMPT_PREFIXES = ['/health', '/metrics'];
