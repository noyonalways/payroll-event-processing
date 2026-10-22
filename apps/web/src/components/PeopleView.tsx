import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Search,
  Plus,
  X,
  User,
  Users,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Archive,
  ArrowRight,
} from 'lucide-react';

import { fetchEventStatus, fetchEventsPage } from '../api/events';
import {
  archiveEmployee,
  createEmployee,
  fetchEmployeesPage,
} from '../api/employees';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import { AnimatedBadge } from '@repo/ui/animated-badge';
import {
  changeTypeLabel,
  describeAppliedChange,
  requestStatus,
  timeAgo,
} from '../lib/humanize';
import type { Employee, EventStatusResponse, EventType } from '../lib/types';

const errorOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

function getInitials(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback.slice(0, 2).toUpperCase();
  return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
}

const statusIconMap: Record<string, React.ReactNode> = {
  great: <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400" />,
  wait: <Clock size={13} className="text-amber-600 dark:text-amber-400" />,
  bad: <AlertTriangle size={13} className="text-destructive" />,
  muted: <X size={13} className="text-muted-foreground" />,
};

function SkeletonPersonRow() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border p-3">
      <div className="skeleton h-10 w-10 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <div className="skeleton h-4 w-32 rounded" />
        <div className="skeleton h-3 w-20 rounded" />
      </div>
      <div className="skeleton h-5 w-14 rounded-full" />
    </div>
  );
}

/**
 * The People view: the roster with each person's current pay details derived
 * from their applied change history, plus a change timeline and a one-click
 * "Request change" that pre-fills the wizard.
 */
export function PeopleView({
  refreshKey,
  onRequestChange,
}: {
  refreshKey: number;
  onRequestChange: (employeeNumber: string) => void;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState<Employee | null>(null);
  const [timeline, setTimeline] = useState<
    Array<{ id: string; type: EventType; status: ReturnType<typeof requestStatus>; createdAt: string }>
  >([]);
  const [current, setCurrent] = useState<string[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ employeeNumber: '', name: '', department: '' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const eventStatusCacheRef = useRef<Map<string, EventStatusResponse>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const page = await fetchEmployeesPage({ limit: 100 });
      setEmployees(page.data);
      setSelected((prev) => {
        if (!prev) return null;
        const found = page.data.find((e) => e.id === prev.id);
        if (!found) return null;
        if (
          found.id === prev.id &&
          found.employeeNumber === prev.employeeNumber &&
          found.name === prev.name &&
          found.department === prev.department
        ) {
          return prev;
        }
        return found;
      });
    } catch (err) {
      setListError(errorOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const selectedEmployeeNumber = selected?.employeeNumber;

  useEffect(() => {
    if (!selectedEmployeeNumber) {
      setTimeline([]);
      setCurrent([]);
      return;
    }
    let cancelled = false;
    setTimelineLoading(true);
    (async () => {
      try {
        const page = await fetchEventsPage({
          employeeId: selectedEmployeeNumber,
          limit: 50,
        });
        const rows = page.data;
        const timelineRows = rows
          .filter((e) => e.status !== 'cancelled')
          .map((e) => ({
            id: e.id,
            type: e.eventType,
            status: requestStatus(e.status),
            createdAt: e.createdAt,
          }));
        if (cancelled) return;
        setTimeline(timelineRows);

        const eventTypes: EventType[] = [
          'BANK_ACCOUNT_CHANGE',
          'SALARY_CHANGE',
          'ADDRESS_CHANGE',
          'DEPARTMENT_CHANGE',
        ];

        const newestEvents = eventTypes
          .map((type) => {
            const newest = rows
              .filter((e) => e.eventType === type && e.status === 'success')
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
            return { type, newest };
          })
          .filter((item): item is { type: EventType; newest: (typeof rows)[number] } => Boolean(item.newest));

        const appliedResults: Array<{ index: number; text: string }> = [];

        await Promise.all(
          newestEvents.map(async ({ type, newest }, index) => {
            try {
              let status = eventStatusCacheRef.current.get(newest.id);
              if (!status) {
                status = await fetchEventStatus(newest.id);
                eventStatusCacheRef.current.set(newest.id, status);
              }
              appliedResults.push({
                index,
                text: describeAppliedChange(type, status.payload, status.result),
              });
            } catch {
              appliedResults.push({
                index,
                text: `${changeTypeLabel(type)} — applied ${timeAgo(newest.processedAt ?? newest.createdAt)}`,
              });
            }
          }),
        );

        appliedResults.sort((a, b) => a.index - b.index);
        if (!cancelled) setCurrent(appliedResults.map((r) => r.text));
      } catch (err) {
        if (!cancelled) setActionError(errorOf(err));
      } finally {
        if (!cancelled) setTimelineLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedEmployeeNumber]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return employees;
    return employees.filter(
      (e) =>
        e.name?.toLowerCase().includes(query) ||
        e.employeeNumber.toLowerCase().includes(query) ||
        e.department?.toLowerCase().includes(query),
    );
  }, [employees, search]);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!form.employeeNumber.trim() || !form.name.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      await createEmployee({
        employeeNumber: form.employeeNumber.trim(),
        name: form.name.trim(),
        ...(form.department.trim() ? { department: form.department.trim() } : {}),
      });
      setForm({ employeeNumber: '', name: '', department: '' });
      setAdding(false);
      await refresh();
    } catch (err) {
      setActionError(errorOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive(employee: Employee) {
    setBusy(true);
    setActionError(null);
    try {
      await archiveEmployee(employee.id);
      await refresh();
    } catch (err) {
      setActionError(errorOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6" data-testid="people-view">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Users size={14} className="text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">People</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">People</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your roster — and each person's current pay details at a glance.
          </p>
        </div>
        <Button
          size="sm"
          variant={adding ? 'outline' : 'default'}
          onClick={() => setAdding((v) => !v)}
          data-testid="people-add-toggle"
          className="gap-2"
        >
          {adding ? <><X size={14} />Cancel</> : <><Plus size={14} />Add person</>}
        </Button>
      </div>

      {/* Add person form */}
      {adding && (
        <form
          className="rounded-2xl border border-border bg-card p-5"
          onSubmit={handleAdd}
          data-testid="people-add-form"
        >
          <h2 className="mb-4 text-sm font-semibold">Add a new employee</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Employee number"
              value={form.employeeNumber}
              onChange={(next) => setForm((p) => ({ ...p, employeeNumber: next }))}
              placeholder="EMP-101"
              data-testid="people-add-number"
            />
            <Input
              label="Full name"
              value={form.name}
              onChange={(next) => setForm((p) => ({ ...p, name: next }))}
              placeholder="Jane Doe"
              data-testid="people-add-name"
            />
            <Input
              label="Department (optional)"
              value={form.department}
              onChange={(next) => setForm((p) => ({ ...p, department: next }))}
              placeholder="Engineering"
              data-testid="people-add-department"
            />
          </div>
          <div className="mt-4 flex gap-3">
            <Button type="submit" size="sm" disabled={busy || !form.employeeNumber.trim() || !form.name.trim()} data-testid="people-add-submit">
              {busy ? 'Adding…' : 'Add employee'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Error banners */}
      {actionError && (
        <div
          className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="people-action-error"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle size={15} className="shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{actionError}</p>
          </div>
          <button
            type="button"
            className="text-xs font-medium text-destructive/70 hover:text-destructive transition-colors"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {listError && (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="people-list-error"
        >
          <AlertTriangle size={15} className="shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{listError}</p>
        </div>
      )}

      {/* Main grid */}
      {loading ? (
        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <SkeletonPersonRow key={i} />
            ))}
          </div>
          <div className="skeleton h-64 rounded-2xl" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          {/* Employee list */}
          <div className="space-y-3">
            <Input
              value={search}
              onChange={setSearch}
              placeholder="Search by name, number, or department…"
              leftIcon={<Search size={15} />}
              data-testid="people-search"
            />
            <ul className="space-y-2" data-testid="people-list">
              {filtered.map((employee) => (
                <li key={employee.id}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-all duration-150 ${
                      selected?.id === employee.id
                        ? 'border-primary/40 bg-primary/8 shadow-sm'
                        : 'border-border bg-card hover:border-primary/25 hover:shadow-sm'
                    }`}
                    onClick={() => {
                      setSelected(employee);
                      setActionError(null);
                    }}
                    data-testid={`people-row-${employee.employeeNumber}`}
                  >
                    {/* Avatar */}
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        selected?.id === employee.id
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {getInitials(employee.name, employee.employeeNumber)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{employee.name ?? '(unnamed)'}</span>
                        <AnimatedBadge
                          status={employee.active ? 'success' : 'neutral'}
                          size="sm"
                        >
                          {employee.active ? 'Active' : 'Archived'}
                        </AnimatedBadge>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {employee.employeeNumber}
                        {employee.department ? ` · ${employee.department}` : ''}
                      </div>
                    </div>
                    {selected?.id === employee.id && (
                      <ArrowRight size={14} className="shrink-0 text-primary" />
                    )}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="rounded-xl border border-dashed border-border bg-card py-10 text-center">
                  <User size={28} className="mx-auto mb-2 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">No employees found.</p>
                </li>
              )}
            </ul>
          </div>

          {/* Detail panel */}
          <div
            className="space-y-4 rounded-2xl border border-border bg-card p-5"
            data-testid="person-panel"
          >
            {!selected ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <User size={22} className="text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium text-foreground">Select an employee</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose someone from the list to see their pay details and history.
                </p>
              </div>
            ) : (
              <>
                {/* Person header */}
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                    {getInitials(selected.name, selected.employeeNumber)}
                  </div>
                  <div>
                    <h2 className="font-semibold" data-testid="person-name">
                      {selected.name ?? '(unnamed)'}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {selected.employeeNumber}
                      {selected.department ? ` · ${selected.department}` : ''}
                    </p>
                  </div>
                </div>

                <div className="h-px bg-border" />

                {/* Current state */}
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Current details
                  </p>
                  {current.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No applied changes yet — details appear after the first change is processed.
                    </p>
                  ) : (
                    <ul className="space-y-1.5" data-testid="person-current">
                      {current.map((line) => (
                        <li key={line} className="flex items-start gap-2 text-sm">
                          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                          {line}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="h-px bg-border" />

                {/* Change timeline */}
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Change history
                  </p>
                  {timelineLoading ? (
                    <div className="space-y-2">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="skeleton h-4 w-full rounded" />
                      ))}
                    </div>
                  ) : timeline.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
                  ) : (
                    <ol className="relative space-y-2 border-l-2 border-border pl-4" data-testid="person-timeline">
                      {timeline.map((entry) => (
                        <li key={entry.id} className="text-sm">
                          <div className="absolute -left-[5px] mt-1.5 h-2 w-2 rounded-full border-2 border-background bg-border" />
                          <div className="flex items-center gap-1.5">
                            {statusIconMap[entry.status.tone]}
                            <span className="font-medium">{changeTypeLabel(entry.type)}</span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {entry.status.label} · {timeAgo(entry.createdAt)}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>

                {/* Actions */}
                {selected.active && (
                  <>
                    <div className="h-px bg-border" />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => onRequestChange(selected.employeeNumber)}
                        data-testid="person-request-change"
                        className="gap-1.5"
                      >
                        <ArrowRight size={13} />
                        Request a change
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 text-muted-foreground hover:bg-muted"
                        disabled={busy}
                        onClick={() => void handleArchive(selected)}
                        data-testid="person-archive"
                      >
                        <Archive size={13} />
                        Archive
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
