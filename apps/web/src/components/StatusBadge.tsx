import { statusBadge } from '../lib/status';
import type { RowStatus } from '../lib/status';

/**
 * Lifecycle status pill. Colors per state are tuned to stay readable in light
 * and dark themes (see the `--color-status-*` tokens in `src/index.css` and the
 * badge map in `src/lib/status.ts`).
 */
export function StatusBadge({ status }: { status: RowStatus }) {
  const { label, className } = statusBadge(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}