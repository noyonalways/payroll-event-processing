import { EventType } from '@repo/shared';
import { AddressChangePayloadDto } from './payloads/address-change.dto';
import { BankAccountChangePayloadDto } from './payloads/bank-account-change.dto';
import { DepartmentChangePayloadDto } from './payloads/department-change.dto';
import { SalaryChangePayloadDto } from './payloads/salary-change.dto';

/**
 * Per-event-type payload DTO classes, keyed by EventType.
 *
 * Adding a new event type = new enum member + new payload DTO registered here.
 * The handler registry (change 4) uses the same pattern on the processing side.
 */
export const PayloadDtoRegistry: Record<EventType, new () => object> = {
  [EventType.BANK_ACCOUNT_CHANGE]: BankAccountChangePayloadDto,
  [EventType.ADDRESS_CHANGE]: AddressChangePayloadDto,
  [EventType.SALARY_CHANGE]: SalaryChangePayloadDto,
  [EventType.DEPARTMENT_CHANGE]: DepartmentChangePayloadDto,
};