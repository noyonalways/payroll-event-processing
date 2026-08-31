import { BadRequestException } from '@nestjs/common';
import { PayloadValidator } from './payload.validator';
import { EventType } from './event-type';

/**
 * DTO-level validation, exercised through the real PayloadValidator
 * (which runs class-validator on the per-type payload DTOs).
 */
describe('PayloadValidator', () => {
  const validator = new PayloadValidator();

  const validPayloads: Record<EventType, Record<string, unknown>> = {
    [EventType.BANK_ACCOUNT_CHANGE]: {
      employeeId: 'emp-1',
      effectiveDate: '2026-09-01',
      iban: 'DE89370400440532013000',
    },
    [EventType.ADDRESS_CHANGE]: {
      employeeId: 'emp-2',
      effectiveDate: '2026-09-01',
      street: 'Main St',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    },
    [EventType.SALARY_CHANGE]: {
      employeeId: 'emp-3',
      effectiveDate: '2026-09-01',
      newSalary: 75_000,
      currency: 'EUR',
    },
    [EventType.DEPARTMENT_CHANGE]: {
      employeeId: 'emp-4',
      effectiveDate: '2026-09-01',
      newDepartment: 'Engineering',
    },
  };

  describe('valid payloads are accepted', () => {
    it.each(Object.values(EventType))(
      'accepts a valid %s payload',
      async (eventType) => {
        await expect(validator.validate(eventType, validPayloads[eventType])).resolves.toBeUndefined();
      },
    );
  });

  describe('invalid payloads are rejected with 400', () => {
    it('rejects a missing required field (iban)', async () => {
      const payload = { ...validPayloads[EventType.BANK_ACCOUNT_CHANGE] } as Record<string, unknown>;
      delete payload.iban;

      await expect(
        validator.validate(EventType.BANK_ACCOUNT_CHANGE, payload),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unknown payload field (bonus)', async () => {
      const payload = { ...validPayloads[EventType.SALARY_CHANGE], bonus: 1_000 };

      await expect(
        validator.validate(EventType.SALARY_CHANGE, payload),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a malformed field value (non-numeric newSalary)', async () => {
      const payload = { ...validPayloads[EventType.SALARY_CHANGE], newSalary: 'not-a-number' };

      await expect(
        validator.validate(EventType.SALARY_CHANGE, payload),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a malformed IBAN', async () => {
      const payload = { ...validPayloads[EventType.BANK_ACCOUNT_CHANGE], iban: 'not-an-iban' };

      await expect(
        validator.validate(EventType.BANK_ACCOUNT_CHANGE, payload),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an empty payload', async () => {
      await expect(
        validator.validate(EventType.ADDRESS_CHANGE, {}),
      ).rejects.toThrow(BadRequestException);
    });
  });
});