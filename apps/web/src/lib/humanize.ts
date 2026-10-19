import type { EventPayload, EventType, LifecycleStatus } from './types';

/**
 * The human vocabulary for the app (frontend-app): payroll people think in
 * "change requests" (a salary update that is applied / in progress / failed
 * needs attention), never in lifecycle enums. Every display string centralizes
 * here so the wording stays consistent across dashboard, requests, and people.
 */

export const CHANGE_TYPE_LABELS: Record<EventType, string> = {
  BANK_ACCOUNT_CHANGE: 'Bank account change',
  SALARY_CHANGE: 'Salary change',
  ADDRESS_CHANGE: 'Address change',
  DEPARTMENT_CHANGE: 'Department change',
};

/** Short labels for chips/icons on dense rows. */
export const CHANGE_TYPE_SHORT: Record<EventType, string> = {
  BANK_ACCOUNT_CHANGE: 'Bank account',
  SALARY_CHANGE: 'Salary',
  ADDRESS_CHANGE: 'Address',
  DEPARTMENT_CHANGE: 'Department',
};

export function changeTypeLabel(type: EventType): string {
  return CHANGE_TYPE_LABELS[type] ?? type;
}

export function changeTypeShort(type: EventType): string {
  return CHANGE_TYPE_SHORT[type] ?? type;
}

/** What a change request means to a payroll person. */
export interface RequestStatus {
  label: string;
  /** 'great' = applied, 'wait' = in flight, 'bad' = needs attention, 'muted' = gone. */
  tone: 'great' | 'wait' | 'bad' | 'muted';
}

const RECEIVED: RequestStatus = { label: 'Received', tone: 'wait' };
const QUEUED: RequestStatus = { label: 'In queue', tone: 'wait' };
const PROCESSING: RequestStatus = { label: 'Processing', tone: 'wait' };
const SUCCESS: RequestStatus = { label: 'Applied', tone: 'great' };
const FAILED: RequestStatus = { label: 'Failed — needs attention', tone: 'bad' };
const CANCELLED: RequestStatus = { label: 'Withdrawn', tone: 'muted' };

export function requestStatus(status: LifecycleStatus): RequestStatus {
  // Web lifecycle values are lowercase (types.ts); accept uppercase too so the
  // helper tolerates wire payloads from either casing convention.
  switch (String(status).toLowerCase()) {
    case 'received':
      return RECEIVED;
    case 'queued':
      return QUEUED;
    case 'processing':
      return PROCESSING;
    case 'success':
      return SUCCESS;
    case 'failed':
      return FAILED;
    case 'cancelled':
      return CANCELLED;
    default:
      return { label: String(status), tone: 'wait' };
  }
}

export const IN_FLIGHT: ReadonlyArray<LifecycleStatus> = [
  'received',
  'queued',
  'processing',
];

/** €75,000.00 style money rendering; falls back to plain text on odd input. */
export function formatMoney(amount: unknown, currency: unknown): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) {
    return `${String(amount ?? '')} ${String(currency ?? '')}`.trim();
  }
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: typeof currency === 'string' && currency.length === 3 ? currency : 'EUR',
    }).format(value);
  } catch {
    return `${value} ${String(currency ?? '')}`.trim();
  }
}

export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / dateLabel for older. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 21) return `${days}d ago`;
  return dateLabel(iso);
}

/**
 * Human sentence for what a SUCCESSFUL change accomplished, from the
 * processing result's acknowledged fields ("Jane's bank account now ends
 * …4321"; "Salary is now €75,000.00 (EUR) effective …").
 */
export function describeAppliedChange(
  type: EventType,
  payload: EventPayload | Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): string {
  const ack = (result?.acknowledged ?? {}) as Record<string, unknown>;
  const source = (Object.keys(ack).length > 0 ? ack : (payload ?? {})) as Record<string, any>;
  const effective = dateLabel(
    typeof source.effectiveDate === 'string' ? source.effectiveDate : null,
  );
  switch (type) {
    case 'BANK_ACCOUNT_CHANGE':
      return `Bank account updated${effective !== '—' ? ` (effective ${effective})` : ''}`;
    case 'SALARY_CHANGE':
      return `Salary is now ${formatMoney(source.newSalary, source.currency)}${
        effective !== '—' ? ` (effective ${effective})` : ''
      }`;
    case 'ADDRESS_CHANGE':
      return `Address updated to ${[
        source.street,
        source.city,
        source.country,
      ]
        .filter(Boolean)
        .join(', ')}${effective !== '—' ? ` (effective ${effective})` : ''}`;
    case 'DEPARTMENT_CHANGE':
      return `Moved to the ${String(source.department ?? '')} department${
        effective !== '—' ? ` (effective ${effective})` : ''
      }`;
    default:
      return 'Change applied';
  }
}

/** The requested change, in one review-style sentence (wizard step 4). */
export function describeRequestedChange(
  type: EventType,
  payload: Record<string, unknown>,
): string {
  switch (type) {
    case 'BANK_ACCOUNT_CHANGE':
      return `Bank account will be updated to IBAN ${payload.iban}`;
    case 'SALARY_CHANGE':
      return `Salary will change to ${formatMoney(payload.newSalary, payload.currency)}`;
    case 'ADDRESS_CHANGE':
      return `Address will be updated to ${[
        payload.street,
        payload.city,
        payload.postalCode,
        payload.country,
      ]
        .filter(Boolean)
        .join(', ')}`;
    case 'DEPARTMENT_CHANGE':
      return `Employee will move to the ${payload.department} department`;
    default:
      return 'Change request';
  }
}
