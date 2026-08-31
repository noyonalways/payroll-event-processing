/**
 * Named request-body examples for POST /events, surfaced by Swagger UI as an
 * "Example Value" dropdown so "Try it out" can be invoked with a valid body in
 * one click. Values mirror the payload-validator spec fixtures.
 */
export interface EventSubmissionExample {
  summary: string;
  value: {
    eventType: string;
    payload: Record<string, unknown>;
  };
}

export const EVENT_EXAMPLES: Record<string, EventSubmissionExample> = {
  'Bank Account Change': {
    summary: 'Change an employee bank account',
    value: {
      eventType: 'BANK_ACCOUNT_CHANGE',
      payload: {
        employeeId: 'emp-123',
        effectiveDate: '2026-09-01',
        iban: 'DE89370400440532013000',
      },
    },
  },
  'Address Change': {
    summary: 'Change an employee address',
    value: {
      eventType: 'ADDRESS_CHANGE',
      payload: {
        employeeId: 'emp-123',
        effectiveDate: '2026-09-01',
        street: 'Main St',
        city: 'Berlin',
        postalCode: '10115',
        country: 'DE',
      },
    },
  },
  'Salary Change': {
    summary: 'Change an employee salary',
    value: {
      eventType: 'SALARY_CHANGE',
      payload: {
        employeeId: 'emp-123',
        effectiveDate: '2026-09-01',
        newSalary: 75000,
        currency: 'EUR',
      },
    },
  },
  'Department Change': {
    summary: 'Transfer an employee to a new department',
    value: {
      eventType: 'DEPARTMENT_CHANGE',
      payload: {
        employeeId: 'emp-123',
        effectiveDate: '2026-09-01',
        newDepartment: 'Engineering',
      },
    },
  },
};