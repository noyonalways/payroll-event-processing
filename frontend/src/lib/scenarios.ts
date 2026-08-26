import { defaultValuesFor } from './eventTypes';
import type { EventType } from './types';

/**
 * Reviewer-facing demo scenarios. Each scenario maps to a reserved backend
 * employee id (`EMP-DEMO-*`) that deterministically forces the simulated
 * outcome server-side — see `src/processing/demo-scenarios.ts` for the
 * authoritative mapping. Picking a scenario re-prefills the employee id and
 * shows what to watch for in the detail panel.
 */
export type DemoScenarioId =
  | 'success'
  | 'retry-recover'
  | 'retry-fail'
  | 'permanent'
  | 'random';

export interface DemoScenario {
  id: DemoScenarioId;
  label: string;
  /** What a reviewer should watch for in the tracked list / detail panel. */
  description: string;
  /** Reserved employee id that forces this outcome server-side. */
  employeeId: string;
}

/**
 * Deterministic success / failure outcomes first, then the plain random path
 * (the default env mode). `success` is first and doubles as the fallback.
 */
export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'success',
    label: 'Success',
    description:
      'Processes cleanly — expect a SUCCESS attempt row at attempt 1.',
    employeeId: 'EMP-DEMO-SUCCESS',
  },
  {
    id: 'retry-recover',
    label: 'Retry, then recover',
    description:
      'Fails transiently on attempts 1–2 (1s → 2s backoff), succeeds at attempt 3 — watch the retry cycle, then the single SUCCESS row.',
    employeeId: 'EMP-DEMO-RECOVER',
  },
  {
    id: 'retry-fail',
    label: 'Retry, then exhausted',
    description:
      'Every attempt fails transiently — retries with backoff (~20 s total), then a single FAILED / TEMPORARY row at the final attempt.',
    employeeId: 'EMP-DEMO-TRANSIENT',
  },
  {
    id: 'permanent',
    label: 'Permanent failure',
    description:
      'Rejected on the first attempt — a single FAILED / PERMANENT row, no retry.',
    employeeId: 'EMP-DEMO-PERMANENT',
  },
  {
    id: 'random',
    label: 'Random (env mode)',
    description:
      'Normal path — the outcome follows PAYROLL_FAILURE_MODE and the failure rates (defaults: 25% transient, 5% permanent).',
    employeeId: 'EMP-001',
  },
];

/** The deterministic success path, so the one-click submit stays green. */
export const DEFAULT_SCENARIO_ID: DemoScenarioId = 'success';

/**
 * Resolves an id to its scenario, falling back to the default (`success`) for
 * unknown ids so the select can never render without a valid scenario.
 */
export function scenarioById(id: string): DemoScenario {
  return DEMO_SCENARIOS.find((s) => s.id === id) ??
    DEMO_SCENARIOS.find((s) => s.id === DEFAULT_SCENARIO_ID)!;
}

/**
 * Pre-filled form values for an event type under a demo scenario: the normal
 * sample defaults with `employeeId` swapped for the scenario's reserved id.
 * Returns a fresh object each call (safe to seed state or reset).
 */
export function nextValues(
  type: EventType,
  scenarioId: DemoScenarioId,
): Record<string, string> {
  return {
    ...defaultValuesFor(type),
    employeeId: scenarioById(scenarioId).employeeId,
  };
}