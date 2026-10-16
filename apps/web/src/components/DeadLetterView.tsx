import { useState } from 'react';

import { EventDetail } from './EventDetail';
import { EventList } from './EventList';
import { Button } from './ui/button';
import { useEventHistory } from '../lib/useEventHistory';
import { useRecovery } from '../lib/useRecovery';

/**
 * The dead-letter view (event-recovery, frontend-app delta): one server-driven
 * page of the organization's terminal `failed` events — the set that needs
 * attention because the automated retries could not save them — fetched from
 * `GET /events?status=failed` (the events-query contract) with the same
 * pagination and per-row polling as the history view. Each entry exposes its
 * identity, attempt count, and badge; selecting one opens the detail (with the
 * failure trail), and a failed row offers the retry action of the recovery
 * capability. A successful retry removes the entry from this selection the
 * next time the failed-only page is fetched (the row re-enters `queued`).
 *
 * An empty organization is an explicit nothing-to-recover state, not a bare
 * list skeleton. The view always reads the caller's organization: the session
 * token scopes every request.
 */
export function DeadLetterView() {
  const dead = useEventHistory({ lockedStatus: 'failed' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const recovery = useRecovery({ onSettled: () => dead.refresh() });
  const selected =
    dead.rows.find((row) => row.id === selectedId) ?? null;

  return (
    <section aria-label="Dead-letter view" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Dead letters</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Failed events that exhausted their automatic retries. Retry re-queues
          an event on its employee's chain; the trail stays append-only, so the
          new attempt continues the last one's number.
        </p>
      </div>

      {recovery.error && (
        <div
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="dead-letter-action-error"
        >
          <span>
            {recovery.error.action === 'retry' ? 'Retry' : 'Cancel'} failed:{' '}
            {recovery.error.message}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={recovery.clearError}
          >
            dismiss
          </Button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          {dead.loadError && (
            <p
              role="alert"
              className="mb-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {dead.loadError}
            </p>
          )}
          {dead.loading ? (
            <p
              className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
              data-testid="dead-letter-loading"
            >
              Loading failed events…
            </p>
          ) : dead.rows.length === 0 && !dead.loadError ? (
            <p
              className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
              data-testid="dead-letter-empty"
            >
              Nothing to recover — the organization has no failed events. Failed
              events show up here the moment an attempt trail ends in failure.
            </p>
          ) : (
            <EventList
              rows={dead.rows}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRetry={recovery.retry}
              onCancel={undefined}
              pendingAction={recovery.pendingAction}
            />
          )}
          {dead.hasMore && !dead.loading && (
            <div className="mt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void dead.loadMore()}
                disabled={dead.loadingMore}
                data-testid="dead-letter-load-more"
              >
                {dead.loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>

        <div>
          {selected ? (
            <EventDetail entry={selected} />
          ) : (
            <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
              Select a failed event to inspect its failure trail before
              retrying it.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
