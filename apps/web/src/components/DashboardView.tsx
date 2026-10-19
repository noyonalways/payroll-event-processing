import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Users,
  RotateCcw,
  XCircle,
  Plus,
  TrendingUp,
  ArrowRight,
  ClipboardList,
} from 'lucide-react';

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
}

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
  great: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  wait: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  bad: 'border-destructive/30 bg-destructive/12 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
};

export function StatusChip({ status }: { status: EventListItem['status'] }) {
  const s = requestStatus(status);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE_CLASS[s.tone]}`}
    >
      {s.label}
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="skeleton mb-3 h-8 w-8 rounded-full" />
      <div className="skeleton mb-2 h-8 w-16 rounded-lg" />
      <div className="skeleton h-4 w-28 rounded" />
    </div>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  value: number;
  label: string;
  colorClass: string;
  bgClass: string;
  onClick: () => void;
  testId?: string;
}

function StatCard({ icon, value, label, colorClass, bgClass, onClick, testId }: StatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-border bg-card p-6 text-left transition-all duration-200 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5"
      data-testid={testId}
    >
      {/* Background accent */}
      <div className={`absolute right-0 top-0 h-24 w-24 rounded-full opacity-10 blur-2xl ${bgClass}`} />

      <div className={`mb-4 inline-flex items-center justify-center rounded-xl p-2.5 ${bgClass} ${colorClass}`}>
        {icon}
      </div>
      <div className={`text-3xl font-bold tabular-nums tracking-tight ${colorClass}`}>
        {value.toLocaleString()}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
        {label}
        <ArrowRight size={13} className="ml-auto opacity-0 transition-opacity group-hover:opacity-60" />
      </div>
    </button>
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
  const inFlight = events.filter((e) => IN_FLIGHT.includes(e.status)).length;
  const failed = events.filter((e) => e.status === 'failed');
  const failedPreview = failed.slice(0, 5);
  const activeEmployees = employees.filter((e) => e.active).length;

  async function act(id: string, action: 'retry' | 'cancel') {
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
    <section className="space-y-8" data-testid="dashboard-view">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Payroll overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every change your team requested — and where it stands right now.
          </p>
        </div>
        <Button
          size="lg"
          onClick={onRequestChange}
          data-testid="dashboard-request-change"
          className="gap-2 shadow-sm"
        >
          <Plus size={16} />
          Request a change
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          data-testid="dashboard-error"
        >
          <AlertTriangle size={16} className="shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Stat cards */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="dashboard-stats">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="dashboard-stats">
            <StatCard
              icon={<CheckCircle2 size={20} />}
              value={applied}
              label="Changes applied"
              colorClass="text-emerald-700 dark:text-emerald-400"
              bgClass="bg-emerald-500/15"
              onClick={onOpenRequests}
              testId="stat-applied"
            />
            <StatCard
              icon={<Clock size={20} />}
              value={inFlight}
              label="In progress"
              colorClass="text-amber-700 dark:text-amber-400"
              bgClass="bg-amber-500/15"
              onClick={onOpenRequests}
            />
            <StatCard
              icon={<AlertTriangle size={20} />}
              value={failed.length}
              label="Failed — needs attention"
              colorClass="text-destructive"
              bgClass="bg-destructive/15"
              onClick={onOpenRequests}
              testId="stat-failed"
            />
            <StatCard
              icon={<Users size={20} />}
              value={activeEmployees}
              label="Active employees"
              colorClass="text-primary"
              bgClass="bg-primary/15"
              onClick={onOpenRequests}
            />
          </div>

          {/* Failed requests panel */}
          {failed.length > 0 && (
            <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-5">
              <div className="mb-4 flex items-center gap-2">
                <AlertTriangle size={16} className="text-destructive" />
                <h2 className="text-sm font-semibold text-destructive">
                  Failed requests — action required
                </h2>
                <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                  {failed.length}
                </span>
              </div>
              <ul className="space-y-2">
                {failedPreview.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
                    data-testid={`dashboard-failed-${e.id}`}
                  >
                    <div>
                      <span className="font-medium">{nameOf(e.employeeId)}</span>
                      <span className="ml-2 text-muted-foreground">
                        · {changeTypeLabel(e.eventType)}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">{timeAgo(e.createdAt)}</span>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingOn === e.id}
                        onClick={() => void act(e.id, 'retry')}
                        data-testid={`dashboard-retry-${e.id}`}
                        className="h-8 gap-1.5"
                      >
                        <RotateCcw size={13} />
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1.5 text-destructive hover:bg-destructive/10"
                        disabled={actingOn === e.id}
                        onClick={() => void act(e.id, 'cancel')}
                        data-testid={`dashboard-cancel-${e.id}`}
                      >
                        <XCircle size={13} />
                        Withdraw
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {actionError && (
                <p className="mt-3 text-xs text-destructive" role="alert">
                  {actionError}
                </p>
              )}
            </div>
          )}

          {/* Recent activity */}
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <TrendingUp size={16} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">Latest activity</h2>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenRequests}
                data-testid="dashboard-view-all"
                className="h-8 gap-1.5 text-xs"
              >
                View all
                <ArrowRight size={13} />
              </Button>
            </div>
            <ul className="divide-y divide-border" data-testid="dashboard-recent">
              {recent.length === 0 && (
                <li className="px-5 py-10 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <ClipboardList size={20} className="text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">No activity yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Start with "Request a change" to see events here.
                  </p>
                </li>
              )}
              {recent.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                >
                  <div>
                    <span className="text-sm font-medium">{nameOf(e.employeeId)}</span>
                    <span className="ml-2 text-sm text-muted-foreground">
                      {changeTypeLabel(e.eventType)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusChip status={e.status} />
                    <span className="text-xs text-muted-foreground">{timeAgo(e.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
        </section>
  );
}
