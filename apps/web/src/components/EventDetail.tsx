import { useEffect, useState } from 'react';

import { fetchEventStatus } from '../api/events';
import { truncateId } from '../lib/format';
import { POLL_INTERVAL_MS } from '../lib/useEventHistory';
import { isTerminal } from '../lib/status';
import type { EventStatusResponse } from '../lib/types';
import type { HistoryRow } from '../lib/useEventHistory';
import { StatusBadge } from './StatusBadge';

export interface EventDetailProps {
  entry: HistoryRow;
  /**
   * True while the event-status-stream is healthy (realtime-status): updates
   * arrive as notifications — the `entry` prop itself moves on the selected
   * event's transitions, re-reading the detail — so the fixed-cadence polling
   * interval is suspended. When the stream is down the poller takes over.
   */
  live?: boolean;
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Detail panel for the selected event: fetches the full `GET /events/{id}`
 * body (payload, sequence, timestamps, result, attempt trail) and refreshes
 * with the row — per stream notification while live, or on the polling cadence
 * while the stream is down — so the panel tracks retries and the terminal
 * write without a manual refresh. A failed fetch (network error or 404)
 * renders the `unavailable` state.
 */
export function EventDetail({ entry, live = false }: EventDetailProps) {
  const [detail, setDetail] = useState<EventStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchEventStatus(entry.id).then(
        (res) => {
          if (cancelled) return;
          setDetail(res);
          setLoadError(null);
        },
        (err: unknown) => {
          if (cancelled) return;
          setDetail(null);
          setLoadError(
            err instanceof Error ? err.message : 'Failed to load event details',
          );
        },
      );
    };
    load();
    if (live || isTerminal(entry.status)) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [entry.id, entry.status, live]);

  if (loadError) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-sm font-semibold">
            Event {truncateId(entry.id)}
          </h2>
          <StatusBadge status="unavailable" />
        </div>
        <p className="mt-2 text-sm text-foreground/80">
          Event details are currently unavailable: {loadError}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The event may be unreachable (for example after a database reset). The
          list keeps polling and recovers when the event is reachable again.
        </p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
        <h2 className="font-mono text-sm font-semibold">
          Event {truncateId(entry.id)}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  const attempts = [...detail.attempts].sort(
    (a, b) => a.attemptNumber - b.attemptNumber,
  );

  return (
    <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-semibold">
          Event {truncateId(detail.id)}
        </h2>
        <StatusBadge status={detail.status} />
      </div>

      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Type</dt>
        <dd>{detail.eventType}</dd>
        <dt className="text-muted-foreground">Employee</dt>
        <dd>{detail.employeeId}</dd>
        <dt className="text-muted-foreground">Sequence</dt>
        <dd>{detail.sequence}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd className="font-mono text-xs">{detail.createdAt}</dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd className="font-mono text-xs">{detail.updatedAt}</dd>
        <dt className="text-muted-foreground">Processed</dt>
        <dd className="font-mono text-xs">{detail.processedAt ?? '—'}</dd>
      </dl>

      {detail.result && (
        <>
          <h3 className="mt-3 text-sm font-semibold">Result</h3>
          <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs text-foreground">
            {jsonBlock(detail.result)}
          </pre>
        </>
      )}

      <h3 className="mt-3 text-sm font-semibold">Payload</h3>
      <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs text-foreground">
        {jsonBlock(detail.payload)}
      </pre>

      <h3 className="mt-3 text-sm font-semibold">
        Attempts ({detail.attempts.length})
      </h3>
      {attempts.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          No attempts recorded yet.
        </p>
      ) : (
        <ol className="mt-1 space-y-2">
          {attempts.map((attempt) => (
            <li
              key={attempt.attemptNumber}
              className="rounded-lg border border-border p-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Attempt {attempt.attemptNumber}</span>
                <StatusBadge
                  status={attempt.status === 'SUCCESS' ? 'success' : 'failed'}
                />
              </div>
              {attempt.errorType && (
                <p className="mt-1 text-xs text-foreground/80">
                  Error type: <span className="font-medium">{attempt.errorType}</span>
                </p>
              )}
              {attempt.failedReason && (
                <p className="mt-1 text-xs text-foreground/80">
                  Reason: {attempt.failedReason}
                </p>
              )}
              {attempt.result && (
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs text-foreground">
                  {jsonBlock(attempt.result)}
                </pre>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {attempt.createdAt}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}