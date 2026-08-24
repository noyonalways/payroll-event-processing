// Jest setupFiles — runs before any test module imports. Pins the environment so
// ConfigModule picks `.env.test` (host-local values). Everything else flows from
// that file; nothing is hard-coded here.
process.env.NODE_ENV = 'test';