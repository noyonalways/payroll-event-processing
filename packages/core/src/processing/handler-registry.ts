import { Injectable } from '@nestjs/common';
import { EventType } from '../events/event-type';
import { PayrollEventStrategy } from './payroll-event.strategy';
import { BankAccountChangeHandler } from './handlers/bank-account-change.handler';
import { AddressChangeHandler } from './handlers/address-change.handler';
import { DepartmentChangeHandler } from './handlers/department-change.handler';
import { SalaryChangeHandler } from './handlers/salary-change.handler';

/**
 * Resolves the processing strategy for an event type, mirroring how the
 * submission side maps types via `PayloadDtoRegistry` (design D1). Adding a new
 * event type = new enum member + payload DTO + handler + one line here.
 */
@Injectable()
export class HandlerRegistry {
  private readonly strategies: Record<EventType, PayrollEventStrategy>;

  constructor(
    bankAccountChange: BankAccountChangeHandler,
    addressChange: AddressChangeHandler,
    salaryChange: SalaryChangeHandler,
    departmentChange: DepartmentChangeHandler,
  ) {
    this.strategies = {
      [EventType.BANK_ACCOUNT_CHANGE]: bankAccountChange,
      [EventType.ADDRESS_CHANGE]: addressChange,
      [EventType.SALARY_CHANGE]: salaryChange,
      [EventType.DEPARTMENT_CHANGE]: departmentChange,
    };
  }

  /**
   * Returns the strategy for `eventType`, throwing on anything not registered —
   * a misconfigured event type must fail fast, never silently skip processing.
   */
  resolve(eventType: EventType | string): PayrollEventStrategy {
    const handler = this.strategies[eventType as EventType];
    if (!handler) {
      throw new Error(
        `No processing handler registered for event type '${String(eventType)}'`,
      );
    }
    return handler;
  }
}