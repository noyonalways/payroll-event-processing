import { useCallback, useEffect, useState } from 'react';

import {
  cancelEvent,
  fetchEventStatus,
  fetchEventsPage,
  retryEvent,
} from '../api/events';
import { fetchEmployeesPage } from '../api/employees';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  changeTypeLabel,
  dateLabel,
  describeAppliedChange,
  IN_FLIGHT,
  requestStatus,
  timeAgo,
} from '../lib/humanize';
import type { EventListItem, EventStatusResponse, EventType, LifecycleStatus } from '../lib/types';

const errorOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

type StatusFilter = 'all' | 'in-flight' | 'success' | 'failed' | 'cancelled';

const QUICK_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'in-flight', label: 'In progress' },
  { id: 'success', label: 'Applied' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Withdrawn' },
];

/**
 * The change-request register (frontend-app rework): every request the
 * organization made, in plain language — who, what, where it stands — with
 * one-click retry/withdraw and a humanized detail view (the old technical
 * "history" and "dead letters" screens merged into this one).
 */
export function RequestsView({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [nameByNumber, setNameByNumber] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<EventType | 'all'>('all');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventStatusResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const [limit] = useState(50);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const [eventPage, employeePage] = await Promise.all([
        fetchEventsPage({ limit: Math.min(limit, 100) }),
        fetchEmployeesPage({ limit: 100 }),
      ]);
      setEvents(eventPage.data);
      setNameByNumber(
        new Map(employeePage.data.map((e) => [e.employeeNumber, e.name ?? e.employeeNumber])),
      );
    } catch (err) {
      setListError(errorOf(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const nameOf = useCallback(
    (employeeId: string) => nameByNumber.get(employeeId) ?? employeeId,
    [nameByNumber],
  );

  const visible = events.filter((e) => {
    if (filter === 'in-flight' && !IN_FLIGHT.includes(e.status)) return false;
    if (filter !== 'all' && filter !== 'in-flight' && e.status !== filter) return false;
    if (typeFilter !== 'all' && e.eventType !== typeFilter) return false;
    const query = search.trim().toLowerCase();
    if (query) {
      const name = nameOf(e.employeeId).toLowerCase();
      if (
        !name.includes(query) &&
        !e.employeeId.toLowerCase().includes(query) &&
        !e.eventType.toLowerCase().includes(query)
      ) {
        return false;
      }
    }
    return true;
  });

  async function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await fetchEventStatus(id));
    } catch (err) {
      setActionError(errorOf(err));
    } finally {
      setDetailLoading(false);
    }
  }

  async function act(id: string, action: 'retry' | 'cancel') {
    setActingOn(id);
    setActionError(null);
    try {
      await (action === 'retry' ? retryEvent(id) : cancelEvent(id));
      await refresh();
      if (expandedId === id) {
        setDetail(await fetchEventStatus(id));
      }
    } catch (err) {
      setActionError(errorOf(err));
    } finally {
      setActingOn(null);
    }
  }

  const eventTypes = Array.from(
    events.reduce((set, e) => set.add(e.eventType), new Set<EventType>()),
  );

  return (
    <section className="space-y-4" data-testid="requests-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Change requests</h2>
          <p className="text-sm text-muted-foreground">
            Every request your team made, newest first.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} data-testid="requests-refresh">
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" data-testid="requests-quick-filters">
          {QUICK_FILTERS.map(({ id, label }) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={filter === id ? 'default' : 'outline'}
              onClick={() => setFilter(id)}
              data-testid={`requests-filter-${id}`}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as EventType | 'all')}
            data-testid="requests-type-filter"
          >
            <option value="all">All changes</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {changeTypeLabel(t)}
              </option>
            ))}
          </select>
          <Input
            value={search}
            onChange={setSearch}
            placeholder="Search person or type…"
            data-testid="requests-search"
          />
        </div>
      </div>

      {actionError && (
        <p className="text-sm text-destructive" role="alert" data-testid="requests-action-error">
          {actionError}
        </p>
      )}
      {listError && (
        <p className="text-sm text-destructive" role="alert" data-testid="requests-list-error">
          {listError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="requests-loading">
          Loading…
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground" data-testid="requests-empty">
          Nothing matches this filter.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="requests-list">
          {visible.map((event: EventListItem) => {
            const status = requestStatus(event.status);
            const expanded = expandedId === event.id;
            return (
              <li
                key={event.id}
                className="rounded-xl border border-border bg-card"
                data-testid={`request-${event.id}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void toggleExpand(event.id)}
                    data-testid={`request-open-${event.id}`}
                  >
                    <div className="text-sm">
                      <span className="font-medium">{nameOf(event.employeeId)}</span>{' '}
                      <span className="text-muted-foreground">
                        ({event.employeeId}) · {changeTypeLabel(event.eventType)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      requested {dateLabel(event.createdAt)} · {timeAgo(event.createdAt)}
                      {event.status === 'SUCCESS' && event.processedAt
                        ? ` · applied ${dateLabel(event.processedAt)}`
                        : ''}
                    </div>
                  </button>
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${
                        status.tone === 'great'
                          ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700'
                          : status.tone === 'bad'
                            ? 'border-destructive/30 bg-destructive/15 text-destructive'
                            : status.tone === 'wait'
                              ? 'border-amber-500/30 bg-amber-500/15 text-amber-700'
                              : 'border-border bg-muted text-muted-foreground'
                      }`}
                    >
                      {status.label}
                    </span>
                    {event.status === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingOn === event.id}
                        onClick={() => void act(event.id, 'retry')}
                        data-testid={`request-retry-${event.id}`}
                      >
                        Retry
                      </Button>
                    )}
                    {IN_FLIGHT.includes(event.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={actingOn === event.id}
                        onClick={() => void act(event.id, 'cancel')}
                        data-testid={`request-cancel-${event.id}`}
                      >
                        Withdraw
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void toggleExpand(event.id)}
                      data-testid={`request-expand-${event.id}`}
                      aria-expanded={expanded}
                    >
                      {expanded ? 'Hide' : 'Details'}
                    </Button>
                  </div>
                </div>

                {expanded && (
                  <div
                    className="space-y-3 border-t border-border px-3 py-3 text-sm"
                    data-testid="request-detail"
                  >
                    {detailLoading || detail === null ? (
                      <p className="text-muted-foreground">Loading details…</p>
                    ) : (
                      <>
                        {detail.status === 'SUCCESS' && (
                          <p className="font-medium text-emerald-700">
                            ✅ {describeAppliedChange(detail.eventType as EventType, detail.payload, detail.result)}
                          </p>
                        )}
                        {detail.status === 'FAILED' && (
                          <p className="font-medium text-destructive">
                            ⚠️ This request failed
                            {detail.attempts.length > 0
                              ? ` after ${detail.attempts.length} attempt(s). Latest reason: ${
                                  detail.attempts[detail.attempts.length - 1].failedReason ??
                                  'unknown'
                                }`
                              : ''}
                            . Retry it when ready — or withdraw.
                          </p>
                        )}
                        {IN_FLIGHT.includes(detail.status as LifecycleStatus) && (
                          <p className="text-amber-700">
                            ⏳ In the pipeline — outcomes appear here the moment they commit.
                          </p>
                        )}
                        {detail.status === 'CANCELLED' && (
                          <p className="text-muted-foreground">Withdrawn — nothing was processed.</p>
                        )}

                        {detail.attempts.length > 0 && (
                          <div>
                            <span className="text-xs font-semibold">Attempt trail</span>
                            <ul className="mt-1 space-y-1">
                              {detail.attempts.map((attempt) => (
                                <li key={attempt.attemptNumber} className="text-xs">
                                  <span className="font-mono">#{attempt.attemptNumber}</span>{' '}
                                  {attempt.status === 'SUCCESS'
                                    ? '✅ applied'
                                    : `⚠️ failed${
                                        attempt.failedReason ? ` — ${attempt.failedReason}` : ''
                                      }`}{' '}
                                  <span className="text-muted-foreground">
                                    · {timeAgo(attempt.createdAt)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
