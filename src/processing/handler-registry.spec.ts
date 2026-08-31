import { HandlerRegistry } from './handler-registry';
import { BankAccountChangeHandler } from './handlers/bank-account-change.handler';
import { AddressChangeHandler } from './handlers/address-change.handler';
import { SalaryChangeHandler } from './handlers/salary-change.handler';
import { DepartmentChangeHandler } from './handlers/department-change.handler';
import { FailureConfig, SimulatedPayrollProvider } from './simulated-payroll-provider';
import { EventType } from '../events/event-type';

describe('HandlerRegistry', () => {
  const provider = new SimulatedPayrollProvider(
    new FailureConfig(0, 0, 'always-success'),
  );
  const registry = new HandlerRegistry(
    new BankAccountChangeHandler(provider),
    new AddressChangeHandler(provider),
    new SalaryChangeHandler(provider),
    new DepartmentChangeHandler(provider),
  );

  it('resolves a distinct handler for each supported event type', () => {
    expect(registry.resolve(EventType.BANK_ACCOUNT_CHANGE)).toBeInstanceOf(
      BankAccountChangeHandler,
    );
    expect(registry.resolve(EventType.ADDRESS_CHANGE)).toBeInstanceOf(
      AddressChangeHandler,
    );
    expect(registry.resolve(EventType.SALARY_CHANGE)).toBeInstanceOf(
      SalaryChangeHandler,
    );
    expect(registry.resolve(EventType.DEPARTMENT_CHANGE)).toBeInstanceOf(
      DepartmentChangeHandler,
    );
  });

  it('resolves by the raw type string the worker job data carries', () => {
    expect(registry.resolve('BANK_ACCOUNT_CHANGE')).toBeInstanceOf(
      BankAccountChangeHandler,
    );
  });

  it('fails fast with an error identifying the unknown event type', () => {
    expect(() => registry.resolve('EXPENSE_REIMBURSEMENT')).toThrow(
      /EXPENSE_REIMBURSEMENT/,
    );
  });
});