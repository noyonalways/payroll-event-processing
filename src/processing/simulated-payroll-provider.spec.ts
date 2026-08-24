import { ConfigService } from '@nestjs/config';
import {
  FailureConfig,
  PayrollFailureMode,
  SimulatedPayrollProvider,
} from './simulated-payroll-provider';
import {
  PermanentPayrollFailureError,
  TransientPayrollFailureError,
} from './errors/payroll-processing.error';

describe('SimulatedPayrollProvider', () => {
  const provider = (mode: PayrollFailureMode, temporary = 0.25, permanent = 0.05) =>
    new SimulatedPayrollProvider(new FailureConfig(temporary, permanent, mode));

  describe('deterministic override (PAYROLL_FAILURE_MODE)', () => {
    it('always-success returns a result with a non-empty reference', async () => {
      const p = provider('always-success');
      const result = await p.simulate();
      expect(result.reference).toMatch(/^SIM-/);
      // Repeated calls never throw under the override.
      await expect(Promise.all([p.simulate(), p.simulate()])).resolves.toHaveLength(2);
    });

    it('always-transient throws a transient failure (isTransient=true)', async () => {
      const p = provider('always-transient');
      await expect(p.simulate()).rejects.toBeInstanceOf(TransientPayrollFailureError);
      await expect(p.simulate()).rejects.toMatchObject({ isTransient: true });
    });

    it('always-permanent throws a permanent failure (isTransient=false)', async () => {
      const p = provider('always-permanent');
      await expect(p.simulate()).rejects.toBeInstanceOf(PermanentPayrollFailureError);
      await expect(p.simulate()).rejects.toMatchObject({ isTransient: false });
    });
  });

  describe('random mode rate config', () => {
    it('with both failure rates 0 every call succeeds', async () => {
      const p = provider('random', 0, 0);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => p.simulate()),
      );
      for (const result of results) {
        expect(result.reference).toMatch(/^SIM-/);
      }
    });

    it('with temporary rate 1.0 every failure is transient', async () => {
      const p = provider('random', 1.0, 0);
      await expect(p.simulate()).rejects.toBeInstanceOf(TransientPayrollFailureError);
      await expect(p.simulate()).rejects.toMatchObject({ isTransient: true });
    });

    it('with permanent rate 1.0 every failure is permanent', async () => {
      const p = provider('random', 0, 1.0);
      await expect(p.simulate()).rejects.toBeInstanceOf(PermanentPayrollFailureError);
      await expect(p.simulate()).rejects.toMatchObject({ isTransient: false });
    });
  });

  describe('FailureConfig.fromEnv', () => {
    const env = (values: Record<string, unknown>) =>
      ({ get: (key: string) => values[key] }) as unknown as ConfigService;

    const PAYROLL_VARS = [
      'PAYROLL_FAILURE_MODE',
      'PAYROLL_TEMPORARY_FAILURE_RATE',
      'PAYROLL_PERMANENT_FAILURE_RATE',
    ] as const;

    beforeEach(() => {
      for (const key of PAYROLL_VARS) {
        delete process.env[key];
      }
    });

    it('reads the rates and mode from ConfigService when process env is unset', () => {
      const config = FailureConfig.fromEnv(
        env({
          PAYROLL_TEMPORARY_FAILURE_RATE: 0.4,
          PAYROLL_PERMANENT_FAILURE_RATE: 0.1,
          PAYROLL_FAILURE_MODE: 'always-transient',
        }),
      );
      expect(config.temporaryFailureRate).toBe(0.4);
      expect(config.permanentFailureRate).toBe(0.1);
      expect(config.mode).toBe('always-transient');
    });

    it('process env overrides the ConfigService snapshot (deterministic runs)', () => {
      process.env.PAYROLL_FAILURE_MODE = 'always-transient';
      process.env.PAYROLL_TEMPORARY_FAILURE_RATE = '0.8';
      process.env.PAYROLL_PERMANENT_FAILURE_RATE = '0.05';
      const config = FailureConfig.fromEnv(env({}));
      expect(config.mode).toBe('always-transient');
      expect(config.temporaryFailureRate).toBe(0.8);
      expect(config.permanentFailureRate).toBe(0.05);
    });

    it('an invalid process env mode is ignored (falls back, never honored)', () => {
      process.env.PAYROLL_FAILURE_MODE = 'always-sideways';
      const config = FailureConfig.fromEnv(
        env({ PAYROLL_FAILURE_MODE: 'always-permanent' }),
      );
      expect(config.mode).toBe('always-permanent');
    });

    it('falls back to defaults when the vars are absent', () => {
      const config = FailureConfig.fromEnv(env({}));
      expect(config.temporaryFailureRate).toBe(0.25);
      expect(config.permanentFailureRate).toBe(0.05);
      expect(config.mode).toBe('random');
    });
  });
});