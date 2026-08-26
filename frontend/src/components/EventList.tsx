import { truncateId } from '../lib/format';
import type { TrackedEvent } from '../lib/storage';
import type { RowStatus } from '../lib/status';
import { StatusBadge } from './StatusBadge';

export interface EventListProps {
  entries: TrackedEvent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function attemptsLabel(attempts: number): string {
  return `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
}

/**
 * Rows for every tracked event. A row whose last poll failed renders the
 * `unavailable` badge; a row with a known per-employee `sequence` shows it.
 * Clicking a row selects it for the detail panel.
 */
export function EventList({ entries, selectedId, onSelect }: EventListProps) {
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        No events tracked yet — submit one above to watch it progress.
      </p>
    );
  }

  return (
    <ul className="space-y-2" aria-label="Tracked events">
      {entries.map((entry) => {
        const status: RowStatus = entry.error ? 'unavailable' : entry.lastStatus;
        const isSelected = entry.id === selectedId;
        return (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onSelect(entry.id)}
              aria-pressed={isSelected}
              className={`flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2 text-left text-sm shadow-sm transition-colors ${
                isSelected
                  ? 'border-primary ring-2 ring-primary/15'
                  : 'border-border hover:border-primary/40'
              }`}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {truncateId(entry.id)}
              </span>
              <span className="font-medium">{entry.eventType}</span>
              <span className="text-muted-foreground">{entry.employeeId}</span>
              {entry.sequence !== undefined && (
                <span className="text-xs text-muted-foreground/70">
                  seq {entry.sequence}
                </span>
              )}
              <StatusBadge status={status} />
              <span className="ml-auto text-xs text-muted-foreground">
                {attemptsLabel(entry.attempts)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}