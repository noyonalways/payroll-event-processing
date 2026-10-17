/**
 * YES, before the ES imports: under the CommonJS transform the plain
 * `require()` runs FIRST, so the throttle constants (@repo/core's
 * throttle.constants reads `real process.env` at import time, FailureConfig
 * precedence) see the tight limits. Individual-file process.env; restored in
 * afterAll so a reused worker process never leaks values into later files.
 */
process.env.DEFAULT_THROTTLE_LIMIT = '3';
process.env.AUTH_THROTTLE_LIMIT = '3';
process.env.DEFAULT_THROTTLE_TTL_SECONDS = '60';
export {};
