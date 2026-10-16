import { Prisma } from '@prisma/client';
import { BankAccountChangeHandler } from './bank-account-change.handler';
import { AddressChangeHandler } from './address-change.handler';
import { DepartmentChangeHandler } from './department-change.handler';
import { SalaryChangeHandler } from './salary-change.handler';
import { EmployeeDomainStateWriter } from '../employee-domain-state.writer';
import { FailureConfig, SimulatedPayrollProvider } from '../simulated-payroll-provider';
import { HandlerInput, EventType, TransientPayrollFailureError } from '@repo/shared';
/**
 * Per-type handler tests use the real provider with the deterministic
 * always-success / always-transient overrides, so the result's acknowledged
 * fields and the state write are exactly observable.
 *
 * The state assertions (domain-effects design D4) pin the write ORDER: the
 * simulated external call completes first, then the handler appends exactly
 * one effective-dated state row through the claim's transaction client, and
 * only then returns the result. A transient provider failure must surface as
 * the transient error class BEFORE any state write is attempted, so the claim
 * transaction rolls back with nothing persisted (reliability R4/R5).
 */
describe('per-type processing handlers', () => {
  const successProvider = new SimulatedPayrollProvider(
    new FailureConfig(0, 0, 'always-success'),
  );
  const transientProvider = new SimulatedPayrollProvider(
    new FailureConfig(0, 0, 'always-transient'),
  );

  let tx: { employeeDomainState: { create: jest.Mock } };
  let writer: EmployeeDomainStateWriter;

  beforeEach(() => {
    tx = { employeeDomainState: { create: jest.fn().mockResolvedValue({}) } };
    writer = new EmployeeDomainStateWriter();
  });

  const input = (
    eventType: EventType,
    payload: Record<string, unknown>,
  ): HandlerInput => ({
    organizationId: 'org-1',
    eventId: 'evt-1',
    eventType,
    employeeId: (payload.employeeId as string) ?? 'emp-1',
    sequence: 1,
    payload,
    attempt: 1,
  });

  /** Runs `handle` against the mocked tx and returns the writer's insert data. */
  const persisted = (): unknown => tx.employeeDomainState.create.mock.calls[0][0];

  it('bank account change acknowledges the iban and persists BANK_ACCOUNT state', async () => {
    const handler = new BankAccountChangeHandler(successProvider, writer);
    const result = await handler.handle(
      input(EventType.BANK_ACCOUNT_CHANGE, {
        employeeId: 'emp-1',
        effectiveDate: '2026-09-01',
        iban: 'DE89370400440532013000',
      }),
      tx as unknown as Prisma.TransactionClient,
    );

    expect(result.reference).toMatch(/^SIM-/);
    expect(result.employeeId).toBe('emp-1');
    expect(result.effectiveDate).toBe('2026-09-01');
    expect(result.acknowledged).toEqual({ iban: 'DE89370400440532013000' });

    expect(tx.employeeDomainState.create).toHaveBeenCalledTimes(1);
    expect(persisted()).toEqual({
      data: {
        organizationId: 'org-1',
        employeeId: 'emp-1',
        domain: 'BANK_ACCOUNT',
        value: { iban: 'DE89370400440532013000' },
        effectiveDate: new Date('2026-09-01'),
        sourceEventId: 'evt-1',
      },
    });
  });

  it('address change acknowledges all supplied address fields and persists ADDRESS state', async () => {
    const handler = new AddressChangeHandler(successProvider, writer);
    const payload = {
      employeeId: 'emp-2',
      effectiveDate: '2026-09-01',
      street: 'Main St',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    };
    const result = await handler.handle(
      input(EventType.ADDRESS_CHANGE, payload),
      tx as unknown as Prisma.TransactionClient,
    );

    expect(result.acknowledged).toEqual({
      street: 'Main St',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    });

    expect(tx.employeeDomainState.create).toHaveBeenCalledTimes(1);
    expect(persisted()).toEqual({
      data: {
        organizationId: 'org-1',
        employeeId: 'emp-2',
        domain: 'ADDRESS',
        value: {
          street: 'Main St',
          city: 'Berlin',
          postalCode: '10115',
          country: 'DE',
        },
        effectiveDate: new Date('2026-09-01'),
        sourceEventId: 'evt-1',
      },
    });
  });

  it('salary change acknowledges newSalary and currency and persists COMPENSATION state', async () => {
    const handler = new SalaryChangeHandler(successProvider, writer);
    const result = await handler.handle(
      input(EventType.SALARY_CHANGE, {
        employeeId: 'emp-3',
        effectiveDate: '2026-09-01',
        newSalary: 75000,
        currency: 'EUR',
      }),
      tx as unknown as Prisma.TransactionClient,
    );

    expect(result.acknowledged).toEqual({ newSalary: 75000, currency: 'EUR' });

    expect(tx.employeeDomainState.create).toHaveBeenCalledTimes(1);
    expect(persisted()).toEqual({
      data: {
        organizationId: 'org-1',
        employeeId: 'emp-3',
        domain: 'COMPENSATION',
        value: { newSalary: 75000, currency: 'EUR' },
        effectiveDate: new Date('2026-09-01'),
        sourceEventId: 'evt-1',
      },
    });
  });

  it('department change acknowledges the new department and persists DEPARTMENT state', async () => {
    const handler = new DepartmentChangeHandler(successProvider, writer);
    const result = await handler.handle(
      input(EventType.DEPARTMENT_CHANGE, {
        employeeId: 'emp-4',
        effectiveDate: '2026-09-01',
        newDepartment: 'Engineering',
      }),
      tx as unknown as Prisma.TransactionClient,
    );

    expect(result.reference).toMatch(/^SIM-/);
    expect(result.employeeId).toBe('emp-4');
    expect(result.effectiveDate).toBe('2026-09-01');
    expect(result.acknowledged).toEqual({ newDepartment: 'Engineering' });

    expect(tx.employeeDomainState.create).toHaveBeenCalledTimes(1);
    expect(persisted()).toEqual({
      data: {
        organizationId: 'org-1',
        employeeId: 'emp-4',
        domain: 'DEPARTMENT',
        value: { newDepartment: 'Engineering' },
        effectiveDate: new Date('2026-09-01'),
        sourceEventId: 'evt-1',
      },
    });
  });

  it('a transient provider failure surfaces before any state write is attempted', async () => {
    // One representative assertion per handler: each must throw the transient
    // error class untouched (BullMQ re-schedules it) and attempt NO state
    // write — the claim transaction then rolls back with zero state persisted.
    const cases = [
      [
        EventType.BANK_ACCOUNT_CHANGE,
        new BankAccountChangeHandler(transientProvider, writer),
        { employeeId: 'emp-1', effectiveDate: '2026-09-01', iban: 'DE89370400440532013000' },
      ],
      [
        EventType.ADDRESS_CHANGE,
        new AddressChangeHandler(transientProvider, writer),
        { employeeId: 'emp-2', effectiveDate: '2026-09-01', street: 'Main St', city: 'Berlin', postalCode: '10115', country: 'DE' },
      ],
      [
        EventType.SALARY_CHANGE,
        new SalaryChangeHandler(transientProvider, writer),
        { employeeId: 'emp-3', effectiveDate: '2026-09-01', newSalary: 75000, currency: 'EUR' },
      ],
      [
        EventType.DEPARTMENT_CHANGE,
        new DepartmentChangeHandler(transientProvider, writer),
        { employeeId: 'emp-4', effectiveDate: '2026-09-01', newDepartment: 'Engineering' },
      ],
    ] as const;

    for (const [eventType, handler, payload] of cases) {
      tx.employeeDomainState.create.mockClear();
      await expect(
        handler.handle(
          input(eventType, payload),
          tx as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toBeInstanceOf(TransientPayrollFailureError);
      expect(tx.employeeDomainState.create).not.toHaveBeenCalled();
    }
  });
});
