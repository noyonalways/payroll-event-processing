import { BankAccountChangeHandler } from './bank-account-change.handler';
import { AddressChangeHandler } from './address-change.handler';
import { DepartmentChangeHandler } from './department-change.handler';
import { SalaryChangeHandler } from './salary-change.handler';
import { FailureConfig, SimulatedPayrollProvider } from '../simulated-payroll-provider';
import { HandlerInput, EventType } from '@repo/shared';/**
 * Per-type handler tests use the real provider with the deterministic
 * always-success override, so the result's acknowledged fields are exactly
 * observable.
 */
describe('per-type processing handlers', () => {
  const provider = new SimulatedPayrollProvider(
    new FailureConfig(0, 0, 'always-success'),
  );

  const input = (
    eventType: EventType,
    payload: Record<string, unknown>,
  ): HandlerInput => ({
    eventId: 'evt-1',
    eventType,
    employeeId: (payload.employeeId as string) ?? 'emp-1',
    sequence: 1,
    payload,
    attempt: 1,
  });

  it('bank account change acknowledges the iban', async () => {
    const handler = new BankAccountChangeHandler(provider);
    const result = await handler.handle(
      input(EventType.BANK_ACCOUNT_CHANGE, {
        employeeId: 'emp-1',
        effectiveDate: '2026-09-01',
        iban: 'DE89370400440532013000',
      }),
    );

    expect(result.reference).toMatch(/^SIM-/);
    expect(result.employeeId).toBe('emp-1');
    expect(result.effectiveDate).toBe('2026-09-01');
    expect(result.acknowledged).toEqual({ iban: 'DE89370400440532013000' });
  });

  it('address change acknowledges all supplied address fields', async () => {
    const handler = new AddressChangeHandler(provider);
    const result = await handler.handle(
      input(EventType.ADDRESS_CHANGE, {
        employeeId: 'emp-2',
        effectiveDate: '2026-09-01',
        street: 'Main St',
        city: 'Berlin',
        postalCode: '10115',
        country: 'DE',
      }),
    );

    expect(result.acknowledged).toEqual({
      street: 'Main St',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    });
  });

  it('salary change acknowledges newSalary and currency', async () => {
    const handler = new SalaryChangeHandler(provider);
    const result = await handler.handle(
      input(EventType.SALARY_CHANGE, {
        employeeId: 'emp-3',
        effectiveDate: '2026-09-01',
        newSalary: 75000,
        currency: 'EUR',
      }),
    );

    expect(result.acknowledged).toEqual({ newSalary: 75000, currency: 'EUR' });
  });

  it('department change acknowledges the new department', async () => {
    const handler = new DepartmentChangeHandler(provider);
    const result = await handler.handle(
      input(EventType.DEPARTMENT_CHANGE, {
        employeeId: 'emp-4',
        effectiveDate: '2026-09-01',
        newDepartment: 'Engineering',
      }),
    );

    expect(result.reference).toMatch(/^SIM-/);
    expect(result.employeeId).toBe('emp-4');
    expect(result.effectiveDate).toBe('2026-09-01');
    expect(result.acknowledged).toEqual({ newDepartment: 'Engineering' });
  });
});