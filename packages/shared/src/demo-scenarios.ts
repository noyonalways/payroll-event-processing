/**
 * Reserved employee-id convention that deterministically forces a simulated
 * outcome, so a reviewer can demonstrate every lifecycle case from the UI
 * without touching `PAYROLL_FAILURE_MODE`. The demo lever wins over the env
 * mode for any submitter (UI, Swagger, curl) — it is a soft convention,
 * documented here, in the frontend scenario selector, and in `.env.example`.
 *
 * Any payload `employeeId` starting with `EMP-DEMO-` is resolved (case- and
 * whitespace-insensitively) to a forced scenario:
 *
 * | Suffix     | Outcome                                                        |
 * | ---------- | -------------------------------------------------------------- |
 * | SUCCESS    | Success on attempt 1 (single `SUCCESS` attempt row at 1)       |
 * | RECOVER    | Transient on attempts 1–2, success at attempt 3 (`FAILED`      |
 * |            | / `TEMPORARY` rows at 1–2, `SUCCESS` row at 3). Requires the   |
 * |            | default `PAYROLL_MAX_RETRY_ATTEMPTS=5` — with fewer attempts   |
 * |            | the event would exhaust before reaching 3.                    |
 * | TRANSIENT  | Always transient → exhausted at max attempts (`FAILED` /       |
 * |            | `TEMPORARY` row at EVERY attempt; the event fails after the    |
 * |            | final one). Default: 5 attempts, backoff 1s→2s→4s→8s, so the   |
 * |            | retry cycle is observable.                                     |
 * | FAILAFTER  | Transient on attempts 1–2, then permanent rejection at attempt |
 * |            | 3 — "retry, then fail" (`FAILED` / `TEMPORARY` rows at 1–2,    |
 * |            | `FAILED` / `PERMANENT` at 3). Requires the default retry       |
 * |            | budget, like RECOVER.                                          |
 * | PERMANENT  | Permanent failure on attempt 1 (single `FAILED` / `PERMANENT`) |
 *
 * A reserved prefix with an unknown suffix (e.g. `EMP-DEMO-BOGUS`, `EMP-DEMO-`)
 * resolves to `null` and falls through to the random env-mode path — the
 * namespace is reserved, but only the five suffixes above are special.
 *
 * Every attempt is recorded — one row per attempt number per event, including
 * mid-retry transient failures — and the demo lever only decides which
 * terminal state the event reaches.
 */
export const DEMO_EMPLOYEE_PREFIX = 'EMP-DEMO-';

export type DemoScenario =
  | 'SUCCESS'
  | 'RECOVER'
  | 'TRANSIENT'
  | 'FAILAFTER'
  | 'PERMANENT';

/** First 1-based attempt on which RECOVER stops failing (default retries = 5). */
export const DEMO_RECOVER_THRESHOLD_ATTEMPT = 3;

/** First 1-based attempt on which FAILAFTER rejects permanently (default retries = 5). */
export const DEMO_FAIL_THRESHOLD_ATTEMPT = 3;

/**
 * Simulated external-call pacing for demo ids. Slower than the regular 10–50 ms
 * path so the UI's 3 s poll observes `queued`/`processing` on the retry
 * scenarios (a single success submission still reads `received → success`).
 */
export const DEMO_PACING_MIN_MS = 900;
export const DEMO_PACING_MAX_MS = 1400;

const SCENARIO_SUFFIXES = [
  'SUCCESS',
  'RECOVER',
  'TRANSIENT',
  'FAILAFTER',
  'PERMANENT',
] as const;

/**
 * Resolves a payload employeeId to a forced demo scenario, or `null` when the
 * id is not reserved. Matching is case-insensitive and trims surrounding
 * whitespace (the payload DTO validates but does not trim).
 */
export function demoScenarioFor(employeeId?: string | null): DemoScenario | null {
  if (employeeId === undefined || employeeId === null) {
    return null;
  }
  const normalized = employeeId.trim().toUpperCase();
  if (!normalized.startsWith(DEMO_EMPLOYEE_PREFIX)) {
    return null;
  }
  const suffix = normalized.slice(DEMO_EMPLOYEE_PREFIX.length);
  return (SCENARIO_SUFFIXES as readonly string[]).includes(suffix)
    ? (suffix as DemoScenario)
    : null;
}