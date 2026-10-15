import { truncateId } from '../lib/format';
import type { HistoryRow } from '../lib/useEventHistory';
import type { RowStatus } from '../lib/status';
import { StatusBadge } from './StatusBadge';

export interface EventListProps {
  rows: HistoryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function attemptsLabel(attempts: number): string {
  return `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}

/**
 * Rows for one page-worth of the organization's server-side history. A row
 * whose last poll failed renders the `unavailable` badge. Clicking a row
 * selects it for the detail panel.
 */
export function EventList({ rows, selectedId, onSelect }: EventListProps) {
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
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onSelect(row.id)}
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
              <span className="ml-auto text-xs text-muted-foreground">
                {attemptsLabel(row.attempts)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
