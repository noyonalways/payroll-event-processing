import { Input } from '@/components/motion/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select';
import { Button } from '@/components/ui/button';

import { hasActiveFilters } from '../lib/useEventHistory';
import type { HistoryFilters } from '../lib/useEventHistory';
import { EVENT_TYPES } from '../lib/types';
import type { EventType, LifecycleStatus } from '../lib/types';

const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  'received',
  'queued',
  'processing',
  'success',
  'failed',
];

const ALL_STATUSES = 'all-statuses';
const ALL_TYPES = 'all-types';

export interface EventFiltersProps {
  filters: HistoryFilters;
  onChange: <K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) => void;
  onClear: () => void;
}

/**
 * The combinable history filters (frontend-app): lifecycle status, event type,
 * employee id, and the inclusive created-date bounds. Each control changes one
 * filter value; the owning hook re-fetches page one — narrowing is server-side,
 * never client-side. Empty sentinels ('' / the `all` options) mean unfiltered.
 */
export function EventFilters({ filters, onChange, onClear }: EventFiltersProps) {
  return (
    <div
      className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="event-filters"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Filters</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Combinable — every change re-fetches the history from the server.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={!hasActiveFilters(filters)}
          data-testid="clear-filters"
        >
          Clear filters
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className="px-1 text-sm font-medium text-foreground">Status</span>
          <Select
            value={filters.status || ALL_STATUSES}
            onValueChange={(value) =>
              onChange('status', value === ALL_STATUSES ? '' : (value as LifecycleStatus))
            }
          >
            <SelectTrigger data-testid="filter-status-trigger" className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES} data-testid="filter-status-option-all">
                All statuses
              </SelectItem>
              {LIFECYCLE_STATUSES.map((status) => (
                <SelectItem
                  key={status}
                  value={status}
                  data-testid={`filter-status-option-${status}`}
                >
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <span className="px-1 text-sm font-medium text-foreground">Event type</span>
          <Select
            value={filters.eventType || ALL_TYPES}
            onValueChange={(value) =>
              onChange('eventType', value === ALL_TYPES ? '' : (value as EventType))
            }
          >
            <SelectTrigger data-testid="filter-type-trigger" className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TYPES} data-testid="filter-type-option-all">
                All types
              </SelectItem>
              {EVENT_TYPES.map((type) => (
                <SelectItem
                  key={type}
                  value={type}
                  data-testid={`filter-type-option-${type}`}
                >
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="sm:col-span-2">
          <Input
            type="text"
            label="Employee id"
            value={filters.employeeId}
            onChange={(value) => onChange('employeeId', value)}
            placeholder="e.g. emp-1 (exact match)"
            data-testid="filter-employee"
          />
        </div>

        <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
          <Input
            type="date"
            label="Created from"
            value={filters.createdAfter}
            onChange={(value) => onChange('createdAfter', value)}
            data-testid="filter-created-after"
          />
          <Input
            type="date"
            label="Created to"
            value={filters.createdBefore}
            onChange={(value) => onChange('createdBefore', value)}
            data-testid="filter-created-before"
          />
        </div>
      </div>
    </div>
  );
}
