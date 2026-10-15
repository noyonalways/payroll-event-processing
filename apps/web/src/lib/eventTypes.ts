import type { EventPayload, EventType } from './types';

/**
 * Which fields each event type collects, and how the demo form renders them.
 * The event-type contract itself is the single workspace copy in
 * `@repo/shared` (design D2); this module owns only the form metadata for it:
 * the exact required field set per type (mirroring the backend
 * `payload-registry` DTOs) as labels, kinds and pre-fill defaults. Keyed by the
 * shared-derived `EventType` (see lib/types.ts), so a new backend event type
 * forces a spec here instead of silently drifting from what the API accepts.
 */

export type FieldValueKind = 'text' | 'date' | 'number';

export interface FieldSpec {
  /** Payload key. */
  name: string;
  /** Human label rendered next to the input. */
  label: string;
  kind: FieldValueKind;
  required: boolean;
  /**
   * Sample value the demo form pre-fills so a reviewer can submit without
   * typing. Mirrors the backend Swagger examples and is chosen to pass the
   * API's validation (IBAN format, ISO-8601 date, positive salary, 3-letter
   * currency, ISO 3166-1 alpha-2 country).
   */
  defaultValue: string;
}

export const EVENT_FIELD_SPECS: Record<EventType, FieldSpec[]> = {
  BANK_ACCOUNT_CHANGE: [
    {
      name: 'employeeId',
      label: 'Employee ID',
      kind: 'text',
      required: true,
      defaultValue: 'EMP-001',
    },
    {
      name: 'effectiveDate',
      label: 'Effective date',
      kind: 'date',
      required: true,
      defaultValue: '2026-09-01',
    },
    {
      name: 'iban',
      label: 'IBAN',
      kind: 'text',
      required: true,
      defaultValue: 'DE89370400440532013000',
    },
  ],
  ADDRESS_CHANGE: [
    {
      name: 'employeeId',
      label: 'Employee ID',
      kind: 'text',
      required: true,
      defaultValue: 'EMP-001',
    },
    {
      name: 'effectiveDate',
      label: 'Effective date',
      kind: 'date',
      required: true,
      defaultValue: '2026-09-01',
    },
    {
      name: 'street',
      label: 'Street',
      kind: 'text',
      required: true,
      defaultValue: 'Hauptstraße 1',
    },
    {
      name: 'city',
      label: 'City',
      kind: 'text',
      required: true,
      defaultValue: 'Berlin',
    },
    {
      name: 'postalCode',
      label: 'Postal code',
      kind: 'text',
      required: true,
      defaultValue: '10115',
    },
    {
      name: 'country',
      label: 'Country',
      kind: 'text',
      required: true,
      defaultValue: 'DE',
    },
  ],
  SALARY_CHANGE: [
    {
      name: 'employeeId',
      label: 'Employee ID',
      kind: 'text',
      required: true,
      defaultValue: 'EMP-001',
    },
    {
      name: 'effectiveDate',
      label: 'Effective date',
      kind: 'date',
      required: true,
      defaultValue: '2026-09-01',
    },
    {
      name: 'newSalary',
      label: 'New salary',
      kind: 'number',
      required: true,
      defaultValue: '75000',
    },
    {
      name: 'currency',
      label: 'Currency',
      kind: 'text',
      required: true,
      defaultValue: 'EUR',
    },
  ],
  DEPARTMENT_CHANGE: [
    {
      name: 'employeeId',
      label: 'Employee ID',
      kind: 'text',
      required: true,
      defaultValue: 'EMP-001',
    },
    {
      name: 'effectiveDate',
      label: 'Effective date',
      kind: 'date',
      required: true,
      defaultValue: '2026-09-01',
    },
    {
      name: 'newDepartment',
      label: 'New department',
      kind: 'text',
      required: true,
      defaultValue: 'Engineering',
    },
  ],
};

export function fieldsFor(type: EventType): FieldSpec[] {
  return EVENT_FIELD_SPECS[type];
}

/**
 * Pre-filled form values for an event type (the demo's "ready to submit"
 * state). Returns a fresh object so callers can safely seed state or reset.
 */
export function defaultValuesFor(type: EventType): Record<string, string> {
  return Object.fromEntries(
    fieldsFor(type).map((spec) => [spec.name, spec.defaultValue]),
  );
}

/**
 * Client-side validation pass over raw form values. Returns a per-field error
 * map (empty when valid). Covers required-field checks and `newSalary > 0`;
 * the API remains the authority for everything else (IBAN format, ISO dates,
 * unknown fields) via its structured 400 responses.
 */
export function validateValues(
  type: EventType,
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const spec of fieldsFor(type)) {
    const value = values[spec.name] ?? '';
    if (spec.required && value.trim() === '') {
      errors[spec.name] = `${spec.label} is required`;
      continue;
    }
    if (spec.kind === 'number' && value.trim() !== '') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        errors[spec.name] = `${spec.label} must be a positive number`;
      }
    }
  }
  return errors;
}

/** Build the request payload from raw form values, coercing number fields. */
export function buildPayload(
  type: EventType,
  values: Record<string, string>,
): EventPayload {
  const payload = fieldsFor(type).reduce<Record<string, string | number>>(
    (acc, spec) => {
      acc[spec.name] =
        spec.kind === 'number' ? Number(values[spec.name]) : values[spec.name];
      return acc;
    },
    {},
  );
  // The dynamic field set per type always matches the corresponding payload
  // interface — this cast is the point where that contract is enforced by test.
  return payload as unknown as EventPayload;
}