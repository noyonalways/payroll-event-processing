import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  PermanentPayrollFailureError,
  TransientPayrollFailureError,
} from './errors/payroll-processing.error';

/** How the simulated provider decides each call's outcome (design D2). */
export type PayrollFailureMode =
  | 'random'
  | 'always-success'
  | 'always-transient'
  | 'always-permanent';

const VALID_MODES: readonly PayrollFailureMode[] = [
  'random',
  'always-success',
  'always-transient',
  'always-permanent',
];

/**
 * Frozen per-call failure probabilities plus the deterministic override.
 * `random` (the default) rolls against the two `PAYROLL_*_FAILURE_RATE` env
 * vars; the `always-*` modes force an outcome so e2e/integration tests are
 * never flaky.
 */
export class FailureConfig {
  constructor(
    readonly temporaryFailureRate: number,
    readonly permanentFailureRate: number,
    readonly mode: PayrollFailureMode = 'random',
  ) {}

  /**
   * Builds the config from the environment. Precedence:
   *
   *   real `process.env` > ConfigService (`.env` snapshot) > Joi defaults
   *
   * ConfigService snapshots `.env` at module-import time, which in a Jest
   * process is BEFORE any `beforeAll` runs — so a `PAYROLL_FAILURE_MODE`
   * override pinned at runtime would never reach it. The live `process.env`
   * (as seen when this factory runs, i.e. during Nest module build) is the
   * authoritative source for the deterministic override (design D2); an
   * invalid `process.env` mode is ignored rather than honored, so a typo falls
   * back to the configured default instead of silently mis-behaving.
   */
  static fromEnv(config: ConfigService): FailureConfig {
    const processMode = process.env.PAYROLL_FAILURE_MODE;
    const mode: PayrollFailureMode = VALID_MODES.includes(
      processMode as PayrollFailureMode,
    )
      ? (processMode as PayrollFailureMode)
      : config.get<PayrollFailureMode>('PAYROLL_FAILURE_MODE') ?? 'random';

    const toNumber = (value: string | undefined, fallback: number): number => {
      if (value === undefined) {
        return fallback;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    return new FailureConfig(
      toNumber(
        process.env.PAYROLL_TEMPORARY_FAILURE_RATE,
        config.get<number>('PAYROLL_TEMPORARY_FAILURE_RATE') ?? 0.25,
      ),
      toNumber(
        process.env.PAYROLL_PERMANENT_FAILURE_RATE,
        config.get<number>('PAYROLL_PERMANENT_FAILURE_RATE') ?? 0.05,
      ),
      mode,
    );
  }
}

/** What the simulated external payroll system returns when the call succeeds. */
export interface SimulatedCallResult {
  /** Opaque confirmation reference from the simulated payroll system. */
  reference: string;
}

/**
 * Simulated external payroll operation. One `simulate()` call models the full
 * round-trip: it either throws a transient/permanent failure at the configured
 * probability (honoring the deterministic override) or returns a success
 * confirmation (design D2).
 */
@Injectable()
export class SimulatedPayrollProvider {
  constructor(private readonly config: FailureConfig) {}

  async simulate(): Promise<SimulatedCallResult> {
    // Simulated network/business latency so the call behaves like an external one.
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs()));

    switch (this.config.mode) {
      case 'always-transient':
        throw new TransientPayrollFailureError(
          'Simulated payroll service unavailable (forced transient failure)',
        );
      case 'always-permanent':
        throw new PermanentPayrollFailureError(
          'Simulated payroll service rejected the change (forced permanent failure)',
        );
      case 'always-success':
        break;
      case 'random':
        this.rollRandomFailure();
        break;
    }

    return { reference: `SIM-${randomUUID()}` };
  }

  /**
   * One random draw: permanent failures are rolled first (p < permanent rate),
   * then transient (p < permanent + temporary). Both rates are 0-1; with both 0
   * every call succeeds.
   */
  private rollRandomFailure(): void {
    const roll = Math.random();
    if (roll < this.config.permanentFailureRate) {
      throw new PermanentPayrollFailureError(
        'Simulated payroll service rejected the change',
      );
    }
    if (roll < this.config.permanentFailureRate + this.config.temporaryFailureRate) {
      throw new TransientPayrollFailureError(
        'Simulated payroll service unavailable',
      );
    }
  }

  private latencyMs(): number {
    return 10 + Math.floor(Math.random() * 40); // 10–50 ms
  }
}