import type { LifecycleStatus } from './types';

/**
 * Status formatting for the tracked list. `unavailable` is a purely local UI
 * state for a row whose last poll failed (network error or 404) — it is not a
 * backend lifecycle status.
 */
export type RowStatus = LifecycleStatus | 'unavailable';

/** A lifecycle status is terminal once polling should stop. */
export function isTerminal(status: LifecycleStatus): boolean {
  return status === 'success' || status === 'failed';
}

export interface StatusBadgeStyle {
  label: string;
  /** Tailwind pill classes, tuned for readability in light and dark. */
  className: string;
}

export const STATUS_BADGES: Record<RowStatus, StatusBadgeStyle> = {
  received: {
    label: 'Received',
    className:
      'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  },
  queued: {
    label: 'Queued',
    className:
      'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  },
  processing: {
    label: 'Processing',
    className:
      'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  success: {
    label: 'Success',
    className:
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  },
  failed: {
    label: 'Failed',
    className: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  },
  unavailable: {
    label: 'Unavailable',
    className:
      'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
};

export function statusBadge(status: RowStatus): StatusBadgeStyle {
  return STATUS_BADGES[status];
}