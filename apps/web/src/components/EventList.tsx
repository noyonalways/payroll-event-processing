import { truncateId } from '../lib/format';
import type { HistoryRow } from '../lib/useEventHistory';
import type { RowStatus } from '../lib/status';
import { Button } from './ui/button';
import { StatusBadge } from './StatusBadge';

export interface EventListProps {
  rows: HistoryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Offer a retry action on `failed` rows (event-recovery); absent = read-only list. */
  onRetry?: (id: string) => void;
  /** Offer a cancel action on pending rows (event-recovery); absent = read-only list. */
  onCancel?: (id: string) => void;
  /** The action in flight; its row's actions render disabled until it settles. */
  pendingAction?: { action: 'retry' | 'cancel'; eventId: string } | null;
}

function attemptsLabel(attempts: number): string {
  return `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}

/**
 * Rows for one page-worth of the organization's server-side history. A row
 * whose last poll failed renders the `unavailable` badge. Clicking a row
 * selects it for the detail panel.
 *
 * With `onRetry`/`onCancel` the list also carries the recovery actions: retry
 * only on `failed` rows, cancel only on pending (`queued`/`received`) rows —
 * terminal rows (`success`, `cancelled`) get none, and an in-flight action
 * disables its own row's buttons. The row itself stays the selection target:
 * the action buttons stop propagation so acting never selects.
 */
export function EventList({
  rows,
  selectedId,
  onSelect,
  onRetry,
  onCancel,
  pendingAction = null,
}: EventListProps) {
  if (rows.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="event-history-empty"
      >
        No events match the current view — adjust the filters or submit an
        event above. The history is served by the API, so anything submitted in
        any session appears here.
      </p>
    );
  }

  return (
    <ul className="space-y-2" aria-label="Event history">
      {rows.map((row) => {
        const status: RowStatus = row.error ? 'unavailable' : row.status;
        const isSelected = row.id === selectedId;
        const busy = pendingAction?.eventId === row.id;
        const offerRetry = onRetry !== undefined && row.status === 'failed' && !row.error;
        const offerCancel =
          onCancel !== undefined &&
          (row.status === 'queued' || row.status === 'received') &&
          !row.error;
        return (
          <li key={row.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(row.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(row.id);
                }
              }}
              aria-pressed={isSelected}
              className={`flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2 text-left text-sm shadow-sm transition-colors ${
                isSelected
                  ? 'border-primary ring-2 ring-primary/15'
                  : 'border-border hover:border-primary/40'
              }`}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {truncateId(row.id)}
              </span>
              <span className="font-medium">{row.eventType}</span>
              <span className="text-muted-foreground">{row.employeeId}</span>
              <span className="text-xs text-muted-foreground/70">
                seq {row.sequence}
              </span>
              <StatusBadge status={status} />
              <span className="text-xs text-muted-foreground">
                {attemptsLabel(row.attempts)}
              </span>
              {(offerRetry || offerCancel) && (
                <span className="ml-auto flex shrink-0 gap-1.5" data-testid="row-actions">
                  {offerRetry && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRetry(row.id);
                      }}
                      data-testid={`retry-${row.id}`}
                    >
                      {busy && pendingAction?.action === 'retry' ? '…' : 'Retry'}
                    </Button>
                  )}
                  {offerCancel && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancel(row.id);
                      }}
                      data-testid={`cancel-${row.id}`}
                    >
                      {busy && pendingAction?.action === 'cancel' ? '…' : 'Cancel'}
                    </Button>
                  )}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
