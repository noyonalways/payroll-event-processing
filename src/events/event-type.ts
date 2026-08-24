/**
 * Supported payroll event types.
 *
 * New event types are a drop-in addition: add the enum member, a payload DTO,
 * and one entry in PayloadDtoRegistry — no controller or service changes.
 */
export enum EventType {
  BANK_ACCOUNT_CHANGE = 'BANK_ACCOUNT_CHANGE',
  ADDRESS_CHANGE = 'ADDRESS_CHANGE',
  SALARY_CHANGE = 'SALARY_CHANGE',
}