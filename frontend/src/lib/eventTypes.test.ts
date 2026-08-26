import { describe, expect, it } from 'vitest';

import {
  buildPayload,
  defaultValuesFor,
  fieldsFor,
  validateValues,
} from './eventTypes';

function fieldNames(type: Parameters<typeof fieldsFor>[0]): string[] {
  return fieldsFor(type).map((spec) => spec.name);
}

describe('eventTypes', () => {
  it('exposes the exact field sets of the event-submission contract', () => {
    expect(fieldNames('BANK_ACCOUNT_CHANGE')).toEqual([
      'employeeId',
      'effectiveDate',
      'iban',
    ]);
    expect(fieldNames('ADDRESS_CHANGE')).toEqual([
      'employeeId',
      'effectiveDate',
      'street',
      'city',
      'postalCode',
      'country',
    ]);
    expect(fieldNames('SALARY_CHANGE')).toEqual([
      'employeeId',
      'effectiveDate',
      'newSalary',
      'currency',
    ]);
  });

  it('marks the shared fields and newSalary correctly typed', () => {
    const salary = fieldsFor('SALARY_CHANGE');
    const newSalary = salary.find((spec) => spec.name === 'newSalary');
    expect(newSalary?.kind).toBe('number');
    expect(newSalary?.required).toBe(true);
    expect(fieldsFor('ADDRESS_CHANGE').every((spec) => spec.required)).toBe(true);
  });

  it('pre-fills every event type with sample defaults', () => {
    expect(defaultValuesFor('BANK_ACCOUNT_CHANGE')).toEqual({
      employeeId: 'EMP-001',
      effectiveDate: '2026-09-01',
      iban: 'DE89370400440532013000',
    });
    expect(defaultValuesFor('ADDRESS_CHANGE')).toEqual({
      employeeId: 'EMP-001',
      effectiveDate: '2026-09-01',
      street: 'Hauptstraße 1',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    });
    expect(defaultValuesFor('SALARY_CHANGE')).toEqual({
      employeeId: 'EMP-001',
      effectiveDate: '2026-09-01',
      newSalary: '75000',
      currency: 'EUR',
    });
  });

  it('builds a payload with number fields coerced', () => {
    const payload = buildPayload('SALARY_CHANGE', {
      employeeId: 'emp-3',
      effectiveDate: '2026-09-01',
      newSalary: '75000',
      currency: 'EUR',
    });
    expect(payload).toEqual({
      employeeId: 'emp-3',
      effectiveDate: '2026-09-01',
      newSalary: 75000,
      currency: 'EUR',
    });
  });

  it('keeps string fields verbatim when building a payload', () => {
    const payload = buildPayload('BANK_ACCOUNT_CHANGE', {
      employeeId: 'emp-1',
      effectiveDate: '2026-09-01',
      iban: 'DE89 3704 0044 0532 0130 00',
    });
    expect(payload).toEqual({
      employeeId: 'emp-1',
      effectiveDate: '2026-09-01',
      iban: 'DE89 3704 0044 0532 0130 00',
    });
  });

  describe('validateValues', () => {
    it('reports every missing required field', () => {
      const errors = validateValues('ADDRESS_CHANGE', {
        employeeId: 'emp-2',
      });
      expect(Object.keys(errors).sort()).toEqual([
        'city',
        'country',
        'effectiveDate',
        'postalCode',
        'street',
      ]);
    });

    it('rejects a non-positive newSalary', () => {
      const errors = validateValues('SALARY_CHANGE', {
        employeeId: 'emp-3',
        effectiveDate: '2026-09-01',
        newSalary: '0',
        currency: 'EUR',
      });
      expect(errors.newSalary).toMatch(/positive number/);
    });

    it('accepts a complete valid submission', () => {
      const errors = validateValues('BANK_ACCOUNT_CHANGE', {
        employeeId: 'emp-1',
        effectiveDate: '2026-09-01',
        iban: 'DE89370400440532013000',
      });
      expect(errors).toEqual({});
    });
  });
});