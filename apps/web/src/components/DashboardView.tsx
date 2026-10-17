import { useCallback, useEffect, useState } from 'react';

import {
  retryEvent,
  cancelEvent,
  fetchEventsPage,
} from '../api/events';
import {
  fetchEmployeesPage,
} from '../api/employees';
import {
  changeTypeLabel,
  IN_FLIGHT,
  requestStatus,
  timeAgo,
} from '../lib/humanize';
import type { Employee, EventListItem } from '../lib/types';
import { Button } from './ui/button';

const errorOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

export interface DashboardData {
  employees: Employee[];
  events: EventListItem[];
  /** Employee numbers the dashboard may resolve to names. */
}

/**
 * The dashboard (frontend-app rework): answers "what needs my attention" at a
 * glance — counts by outcome, failed requests with one-click retry/withdraw,
 * and the latest activity. All numbers derive from real API data (the
 * organization's event history + directory), never local bookkeeping.
 */
export function useDashboardData(refreshKey: number) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [employeePage, eventPage] = await Promise.all([
        fetchEmployeesPage({ limit: 100 }),
        fetchEventsPage({ limit: 100 }),
      ]);
      setEmployees(employeePage.data);
      setEvents(eventPage.data);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return { employees, events, loading, error, refresh };
}

const STATUS_TONE_CLASS: Record<string, string> = {
  great: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700',
  wait: 'border-amber-500/30 bg-amber-500/15 text-amber-700',
  bad: 'border-destructive/30 bg-destructive/15 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
};

export function StatusChip({ status }: { status: EventListItem['status'] }) {
  const s = requestStatus(status);
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_TONE_CLASS[s.tone]}`}
    >
      {s.label}
    </span>
  );
}

export function DashboardView({
  refreshKey,
  onRequestChange,
  onOpenRequests,
  onChanged,
}: {
  refreshKey: number;
  onRequestChange: () => void;
  onOpenRequests: () => void;
  /** Lets the parent (requests/dashboard share) know data moved. */
  onChanged?: () => void;
}) {
  const { employees, events, loading, error, refresh } = useDashboardData(refreshKey);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const nameOf = useCallback(
    (employeeId: string) =>
      employees.find((e) => e.employeeNumber === employeeId)?.name ?? employeeId,
    [employees],
  );

  const applied = events.filter((e) => e.status === 'success').length;
  const failed = events.filter((e) => e.status === 'failed');
  const failedPreview = failed.slice(0, 5);

  async function act(
    id: string,
    action: 'retry' | 'cancel',
  ) {
    setActingOn(id);
    setActionError(null);
    try {
      if (action === 'retry') {
        await retryEvent(id);
      } else {
        await cancelEvent(id);
      }
      await refresh();
      onChanged?.();
    } catch (err) {
      setActionError(errorOf(err));
    } finally {
      setActingOn(null);
    }
  }

  const recent = [...events]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 8);

  return (
    <section className="space-y-6" data-testid="dashboard-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Payroll overview</h2>
          <p className="text-sm text-muted-foreground">
            Every change your team requested, and where it stands.
          </p>
        </div>
        <Button size="lg" onClick={onRequestChange} data-testid="dashboard-request-change">
          Request a change
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="dashboard-error">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="dashboard-loading">
          Loading…
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="dashboard-stats">
            <button
              type="button"
              onClick={onOpenRequests}
              className="rounded-xl border border-border bg-card p-4 text-left hover:border-primary/30"
              data-testid="stat-applied"
            >
              <div className="text-3xl font-semibold tabular-nums">{applied}</div>
              <div className="mt-1 text-sm text-muted-foreground">Changes applied</div>
            </button>
            <button
              type="button"
              onClick={onOpenRequests}
              className="rounded-xl border border-border bg-card p-4 text-left hover:border-primary/30"
            >
              <div className="text-3xl font-semibold tabular-nums">
                {events.filter((e) => IN_FLIGHT.includes(e.status)).length}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">In progress</div>
            </button>
            <button
              type="button"
              onClick={onOpenRequests}
              className="rounded-xl border border-border bg-card p-4 text-left hover:border-primary/30"
            >
              <div className="text-3xl font-semibold tabular-nums text-destructive" data-testid="stat-failed">{failed.length}</div>
              <div className="mt-1 text-sm text-muted-foreground">Failed — needs attention</div>
            </button>
            <button
              type="button"
              onClick={onOpenRequests}
              className="rounded-xl border border-border bg-card p-4 text-left hover:border-primary/30"
            >
              <div className="text-3xl font-semibold tabular-nums">
                {employees.filter((e) => e.active).length}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">Active employees</div>
            </button>
          </div>

          {failed.length > 0 && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <h3 className="text-sm font-semibold text-destructive">
                Failed requests — fix and retry, or withdraw
              </h3>
              <ul className="mt-2 space-y-2">
                {failedPreview.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                    data-testid={`dashboard-failed-${e.id}`}
                  >
                    <span>
                      {nameOf(e.employeeId)} · {changeTypeLabel(e.eventType)}{' '}
                      <span className="text-muted-foreground">· {timeAgo(e.createdAt)}</span>
                    </span>
                    <span className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingOn === e.id}
                        onClick={() => void act(e.id, 'retry')}
                        data-testid={`dashboard-retry-${e.id}`}
                      >
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={actingOn === e.id}
                        onClick={() => void act(e.id, 'cancel')}
                        data-testid={`dashboard-cancel-${e.id}`}
                      >
                        Withdraw
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
              {actionError && (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {actionError}
                </p>
              )}
            </div>
          )}

          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Latest activity</h3>
              <Button variant="ghost" size="sm" onClick={onOpenRequests} data-testid="dashboard-view-all">
                View all
              </Button>
            </div>
            <ul className="divide-y divide-border" data-testid="dashboard-recent">
              {recent.length === 0 && (
                <li className="px-4 py-6 text-sm text-muted-foreground">
                  No change requests yet — start with “Request a change”.
                </li>
              )}
              {recent.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span>
                    <span className="font-medium">{nameOf(e.employeeId)}</span>{' '}
                    <span className="text-muted-foreground">·</span> {changeTypeLabel(e.eventType)}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-muted-foreground">
                    <StatusChip status={e.status} />
                    {timeAgo(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
