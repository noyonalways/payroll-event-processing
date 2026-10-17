// Jest setupFiles — runs before any test module imports. Pins the environment so
// ConfigModule picks `.env.test` (host-local values). Everything else flows from
// that file; nothing is hard-coded here.
process.env.NODE_ENV = 'test';

// ── Auth-hardening test posture ───────────────────────────────────────────────
// Throttling is INERT for every suite (limits above any suite's request
// volume); the dedicated throttling e2e tightens these in its own file and
// RESTORES them in its afterAll (setupFiles re-run per test file, so every
// file starts from these inert values again).
process.env.AUTH_THROTTLE_LIMIT = '1000';
process.env.AUTH_THROTTLE_TTL_SECONDS = '60';
process.env.DEFAULT_THROTTLE_LIMIT = '10000';
process.env.DEFAULT_THROTTLE_TTL_SECONDS = '60';
process.env.AUTH_LOCKOUT_THRESHOLD = '5';
process.env.AUTH_LOCKOUT_MINUTES = '15';
process.env.AUTH_RESET_TTL_MINUTES = '30';
