import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCENARIO_ID,
  DEMO_SCENARIOS,
  nextValues,
  scenarioById,
} from './scenarios';
import type { EventType } from './types';

const ALL_EVENT_TYPES: EventType[] = [
  'BANK_ACCOUNT_CHANGE',
  'ADDRESS_CHANGE',
  'SALARY_CHANGE',
];

describe('demo scenarios', () => {
  it('defaults to the deterministic success scenario', () => {
    expect(DEFAULT_SCENARIO_ID).toBe('success');
  });

  it('exposes exactly the six reviewer scenarios with stable ids', () => {
    expect(DEMO_SCENARIOS.map((s) => s.id)).toEqual([
      'success',
      'retry-recover',
      'retry-fail',
      'fail-after-retries',
      'permanent',
      'random',
    ]);
  });

  it('maps every scenario id to its reserved employee id', () => {
    expect(scenarioById('success').employeeId).toBe('EMP-DEMO-SUCCESS');
    expect(scenarioById('retry-recover').employeeId).toBe('EMP-DEMO-RECOVER');
    expect(scenarioById('retry-fail').employeeId).toBe('EMP-DEMO-TRANSIENT');
    expect(scenarioById('fail-after-retries').employeeId).toBe('EMP-DEMO-FAILAFTER');
    expect(scenarioById('permanent').employeeId).toBe('EMP-DEMO-PERMANENT');
    expect(scenarioById('random').employeeId).toBe('EMP-001');
  });

  it('falls back to the default scenario for unknown ids', () => {
    expect(scenarioById('not-a-scenario').id).toBe('success');
  });

  it('nextValues keeps the per-type sample defaults and overrides the employee id', () => {
    for (const type of ALL_EVENT_TYPES) {
      const values = nextValues(type, 'retry-fail');
      expect(values.employeeId).toBe('EMP-DEMO-TRANSIENT');
      expect(values.effectiveDate).toBe('2026-09-01');
    }
  });

  it('random keeps the ordinary sample employee id (default env-mode path)', () => {
    for (const type of ALL_EVENT_TYPES) {
      expect(nextValues(type, 'random').employeeId).toBe('EMP-001');
    }
  });
});