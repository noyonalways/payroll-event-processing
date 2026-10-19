import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Search,
  CheckCircle2,
  Clock,
  XCircle,
  AlertTriangle,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Filter,
  ListFilter,
} from 'lucide-react';

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

const QUICK_FILTERS: Array<{
  id: StatusFilter;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: 'all', label: 'All', icon: <ListFilter size={13} /> },
  { id: 'in-flight', label: 'In progress', icon: <Clock size={13} /> },
  { id: 'success', label: 'Applied', icon: <CheckCircle2 size={13} /> },
  { id: 'failed', label: 'Failed', icon: <AlertTriangle size={13} /> },
  { id: 'cancelled', label: 'Withdrawn', icon: <XCircle size={13} /> },
];

const STATUS_CLASSES: Record<string, string> = {
  great: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  wait: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  bad: 'border-destructive/30 bg-destructive/12 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
};

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="space-y-2">
        <div className="skeleton h-4 w-40 rounded" />
        <div className="skeleton h-3 w-24 rounded" />
      </div>
      <div className="flex items-center gap-3">
        <div className="skeleton h-5 w-16 rounded-full" />
        <div className="skeleton h-7 w-14 rounded-lg" />
      </div>
    </div>
  );
}

/**
 * The change-request register: every request the organization made, in plain
 * language — who, what, where it stands — with one-click retry/withdraw and a
 * humanized detail view showing the attempt trail.
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

  const filterCounts: Record<StatusFilter, number> = {
    all: events.length,
    'in-flight': events.filter((e) => IN_FLIGHT.includes(e.status)).length,
    success: events.filter((e) => e.status === 'success').length,
    failed: events.filter((e) => e.status === 'failed').length,
    cancelled: events.filter((e) => e.status === 'cancelled').length,
  };

  return (
    <section className="space-y-6" data-testid="requests-view">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Change requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every request your team made — newest first.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          data-testid="requests-refresh"
          className="gap-2"
        >
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {/* Filters bar */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="requests-quick-filters">
          {QUICK_FILTERS.map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              data-testid={`requests-filter-${id}`}
              className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-all duration-150 ${
                filter === id
                  ? 'border-primary/40 bg-primary/10 text-primary shadow-sm'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/25 hover:text-foreground'
              }`}
            >
              {icon}
              {label}
              {filterCounts[id] > 0 && (
                <span
                  className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    filter === id
                      ? 'bg-primary/20 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {filterCounts[id]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Filter size={14} className="text-muted-foreground" />
          <select
            className="h-8 rounded-lg border border-border bg-card px-3 text-xs text-foreground outline-none transition-colors focus:border-primary/40 focus:ring-2 focus:ring-primary/20"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as EventType | 'all')}
            data-testid="requests-type-filter"
          >
            <option value="all">All change types</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {changeTypeLabel(t)}
              </option>
            ))}
          </select>
          <div className="flex-1 min-w-48">
            <Input
              value={search}
              onChange={setSearch}
              placeholder="Search by name or type…"
              leftIcon={<Search size={15} />}
              data-testid="requests-search"
            />
          </div>
        </div>
      </div>

      {/* Error banners */}
      {actionError && (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="requests-action-error"
        >
          <AlertTriangle size={15} className="shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{actionError}</p>
        </div>
      )}
      {listError && (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="requests-list-error"
        >
          <AlertTriangle size={15} className="shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{listError}</p>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="space-y-2" data-testid="requests-loading">
          {[1, 2, 3, 4, 5].map((i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div
          className="rounded-2xl border border-dashed border-border bg-card py-16 text-center"
          data-testid="requests-empty"
        >
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <ListFilter size={20} className="text-muted-foreground/50" />
          </div>
          <p className="text-sm font-medium text-foreground">No requests match this filter</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try clearing the filters or switching to "All".
          </p>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="requests-list">
          {visible.map((event: EventListItem) => {
            const status = requestStatus(event.status);
            const expanded = expandedId === event.id;
            return (
              <li
                key={event.id}
                className="overflow-hidden rounded-2xl border border-border bg-card transition-shadow hover:shadow-sm"
                data-testid={`request-${event.id}`}
              >
                {/* Row header */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void toggleExpand(event.id)}
                    data-testid={`request-open-${event.id}`}
                  >
                    <div className="text-sm">
                      <span className="font-semibold">{nameOf(event.employeeId)}</span>{' '}
                      <span className="text-muted-foreground">
                        ({event.employeeId}) · {changeTypeLabel(event.eventType)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Requested {dateLabel(event.createdAt)} · {timeAgo(event.createdAt)}
                      {event.status === 'success' && event.processedAt
                        ? ` · Applied ${dateLabel(event.processedAt)}`
                        : ''}
                    </div>
                  </button>

                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[status.tone]}`}
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
                        className="h-7 gap-1.5 px-2.5 text-xs"
                      >
                        <RotateCcw size={12} />
                        Retry
                      </Button>
                    )}
                    {IN_FLIGHT.includes(event.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 px-2.5 text-xs text-destructive hover:bg-destructive/10"
                        disabled={actingOn === event.id}
                        onClick={() => void act(event.id, 'cancel')}
                        data-testid={`request-cancel-${event.id}`}
                      >
                        <XCircle size={12} />
                        Withdraw
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => void toggleExpand(event.id)}
                      data-testid={`request-expand-${event.id}`}
                      aria-expanded={expanded}
                      title={expanded ? 'Collapse' : 'Expand'}
                    >
                      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </Button>
                  </div>
                </div>

                {/* Expanded detail */}
                {expanded && (
                  <div
                    className="space-y-4 border-t border-border bg-muted/30 px-4 py-4 text-sm"
                    data-testid="request-detail"
                  >
                    {detailLoading || detail === null ? (
                      <div className="space-y-2">
                        <div className="skeleton h-4 w-3/4 rounded" />
                        <div className="skeleton h-4 w-1/2 rounded" />
                      </div>
                    ) : (
                      <>
                        {/* Status summary */}
                        <div
                          className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 ${
                            detail.status === 'success'
                              ? 'border-emerald-500/25 bg-emerald-500/8'
                              : detail.status === 'failed'
                                ? 'border-destructive/25 bg-destructive/8'
                                : IN_FLIGHT.includes(detail.status as LifecycleStatus)
                                  ? 'border-amber-500/25 bg-amber-500/8'
                                  : 'border-border bg-muted/30'
                          }`}
                        >
                          {detail.status === 'success' && (
                            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600" />
                          )}
                          {detail.status === 'failed' && (
                            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-destructive" />
                          )}
                          {IN_FLIGHT.includes(detail.status as LifecycleStatus) && (
                            <Clock size={15} className="mt-0.5 shrink-0 text-amber-600" />
                          )}
                          {detail.status === 'cancelled' && (
                            <XCircle size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                          )}
                          <p className={
                            detail.status === 'success'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : detail.status === 'failed'
                                ? 'text-destructive'
                                : IN_FLIGHT.includes(detail.status as LifecycleStatus)
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-muted-foreground'
                          }>
                            {detail.status === 'success' &&
                              describeAppliedChange(detail.eventType as EventType, detail.payload, detail.result)}
                            {detail.status === 'failed' &&
                              `This request failed${
                                detail.attempts.length > 0
                                  ? ` after ${detail.attempts.length} attempt(s). Latest reason: ${
                                      detail.attempts[detail.attempts.length - 1].failedReason ?? 'unknown'
                                    }`
                                  : ''
                              }. Retry when ready, or withdraw.`}
                            {IN_FLIGHT.includes(detail.status as LifecycleStatus) &&
                              'In the pipeline — outcomes appear here the moment they commit.'}
                            {detail.status === 'cancelled' &&
                              'Withdrawn — nothing was processed.'}
                          </p>
                        </div>

                        {/* Attempt trail */}
                        {detail.attempts.length > 0 && (
                          <div>
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Attempt trail
                            </p>
                            <ol className="relative space-y-2 border-l-2 border-border pl-4">
                              {detail.attempts.map((attempt) => (
                                <li key={attempt.attemptNumber} className="text-xs">
                                  <div className="absolute -left-[5px] mt-1 h-2 w-2 rounded-full border-2 border-background bg-border" />
                                  <span className="font-mono font-semibold">
                                    #{attempt.attemptNumber}
                                  </span>{' '}
                                  <span
                                    className={
                                      attempt.status === 'SUCCESS'
                                        ? 'text-emerald-700 dark:text-emerald-400'
                                        : 'text-destructive'
                                    }
                                  >
                                    {attempt.status === 'SUCCESS' ? 'Applied' : 'Failed'}
                                    {attempt.failedReason ? ` — ${attempt.failedReason}` : ''}
                                  </span>{' '}
                                  <span className="text-muted-foreground">
                                    · {timeAgo(attempt.createdAt)}
                                  </span>
                                </li>
                              ))}
                            </ol>
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
