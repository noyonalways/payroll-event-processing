import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { fetchEventStatus, fetchEventsPage } from '../api/events';
import {
  archiveEmployee,
  createEmployee,
  fetchEmployeesPage,
} from '../api/employees';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  changeTypeLabel,
  describeAppliedChange,
  requestStatus,
  timeAgo,
} from '../lib/humanize';
import type { Employee, EventType } from '../lib/types';

const errorOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

const typeToTitle = (type: EventType): string =>
  type.charAt(0) + type.slice(1).toLowerCase().replace('_change', ' change');

/**
 * The People view (frontend-app rework): the roster with each person's
 * CURRENT state — the applied bank account, salary, address, and department
 * derived from their successfully applied changes — plus the change timeline
 * and a one-click "Request change" that pre-fills the wizard for them.
 *
 * "Current" is derived from the source of truth (this organization's applied
 * change requests), so what's shown is exactly what the pipeline applied.
 */
export function PeopleView({
  refreshKey,
  onRequestChange,
}: {
  refreshKey: number;
  /** Fires with the employee number to pre-fill the wizard with. */
  onRequestChange: (employeeNumber: string) => void;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState<Employee | null>(null);
  const [timeline, setTimeline] = useState<
    Array<{ id: string; type: EventType; status: ReturnType<typeof requestStatus>; createdAt: string; applied: string }>
  >([]);
  const [current, setCurrent] = useState<string[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ employeeNumber: '', name: '', department: '' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const page = await fetchEmployeesPage({ limit: 100 });
      setEmployees(page.data);
      setSelected((prev) =>
        prev ? (page.data.find((e) => e.id === prev.id) ?? null) : null,
      );
    } catch (err) {
      setListError(errorOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // Load the selected person's applied state + change timeline.
  useEffect(() => {
    if (!selected) {
      setTimeline([]);
      setCurrent([]);
      return;
    }
    let cancelled = false;
    setTimelineLoading(true);
    (async () => {
      try {
        const page = await fetchEventsPage({
          employeeId: selected.employeeNumber,
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
            applied: '',
          }));
        if (cancelled) return;
        setTimeline(timelineRows);

        // Current state: for each domain, the newest APPLIED change, with the
        // "what it became" line from that change's committed result (GET
        // /events/{id} — list rows carry no values by design).
        const latestApplied: string[] = [];
        for (const type of ['BANK_ACCOUNT_CHANGE', 'SALARY_CHANGE', 'ADDRESS_CHANGE', 'DEPARTMENT_CHANGE'] as EventType[]) {
          const newest = rows
            .filter((e) => e.eventType === type && e.status === 'success')
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
          if (!newest) continue;
          try {
            const status = await fetchEventStatus(newest.id);
            latestApplied.push(
              describeAppliedChange(type, status.payload, status.result),
            );
          } catch {
            latestApplied.push(`${typeToTitle(type)} — applied ${timeAgo(newest.processedAt ?? newest.createdAt)}`);
          }
        }
        if (!cancelled) setCurrent(latestApplied);
      } catch (err) {
        if (!cancelled) setActionError(errorOf(err));
      } finally {
        if (!cancelled) setTimelineLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

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
    <section className="space-y-4" data-testid="people-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">People</h2>
          <p className="text-sm text-muted-foreground">
            Your roster — and each person's current pay details at a glance.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding((v) => !v)} data-testid="people-add-toggle">
          {adding ? 'Close' : '+ Add person'}
        </Button>
      </div>

      {adding && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4"
          onSubmit={handleAdd}
          data-testid="people-add-form"
        >
          <div className="min-w-36">
            <Input
              label="Employee number"
              value={form.employeeNumber}
              onChange={(next) => setForm((p) => ({ ...p, employeeNumber: next }))}
              placeholder="EMP-101"
              data-testid="people-add-number"
            />
          </div>
          <div className="min-w-40">
            <Input
              label="Name"
              value={form.name}
              onChange={(next) => setForm((p) => ({ ...p, name: next }))}
              placeholder="Jane Doe"
              data-testid="people-add-name"
            />
          </div>
          <div className="min-w-36">
            <Input
              label="Department (optional)"
              value={form.department}
              onChange={(next) => setForm((p) => ({ ...p, department: next }))}
              placeholder="Engineering"
              data-testid="people-add-department"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy} data-testid="people-add-submit">
            Add
          </Button>
        </form>
      )}

      {actionError && (
        <p className="text-sm text-destructive" role="alert" data-testid="people-action-error">
          {actionError}
        </p>
      )}
      {listError && (
        <p className="text-sm text-destructive" role="alert" data-testid="people-list-error">
          {listError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="people-loading">
          Loading…
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          <div className="space-y-2">
            <Input
              label="Search"
              value={search}
              onChange={setSearch}
              placeholder="Search name, number, department…"
              data-testid="people-search"
            />
            <ul className="space-y-2" data-testid="people-list">
              {filtered.map((employee) => (
                <li key={employee.id}>
                  <button
                    type="button"
                    className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                      selected?.id === employee.id
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border bg-card hover:border-primary/20'
                    }`}
                    onClick={() => setSelected(employee)}
                    data-testid={`people-row-${employee.employeeNumber}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{employee.name ?? '(unnamed)'}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${
                          employee.active
                            ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700'
                            : 'border-border bg-muted text-muted-foreground'
                        }`}
                      >
                        {employee.active ? 'active' : 'archived'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {employee.employeeNumber}
                      {employee.department ? ` · ${employee.department}` : ''}
                    </div>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                  No people found.
                </li>
              )}
            </ul>
          </div>

          <div className="space-y-3 rounded-xl border border-border bg-card p-4" data-testid="person-panel">
            {!selected ? (
              <p className="text-sm text-muted-foreground">
                Select a person to see their current pay details and change history.
              </p>
            ) : (
              <>
                <div>
                  <h3 className="text-lg font-semibold" data-testid="person-name">
                    {selected.name ?? '(unnamed)'}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {selected.employeeNumber}
                    {selected.department ? ` · ${selected.department}` : ''}
                  </p>
                </div>

                <div>
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Current state
                  </span>
                  <ul className="mt-1 space-y-1 text-sm" data-testid="person-current">
                    {current.length === 0 && (
                      <li className="text-muted-foreground">
                        No applied changes yet — everything starts after the first
                        request is applied.
                      </li>
                    )}
                    {current.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>

                <div>
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Recent changes
                  </span>
                  {timelineLoading ? (
                    <p className="mt-1 text-sm text-muted-foreground">Loading…</p>
                  ) : (
                    <ul className="mt-1 space-y-1.5" data-testid="person-timeline">
                      {timeline.length === 0 && (
                        <li className="text-sm text-muted-foreground">No changes yet.</li>
                      )}
                      {timeline.map((entry) => (
                        <li key={entry.id} className="text-sm">
                          {changeTypeLabel(entry.type)}{' '}
                          <span
                            className={`text-xs ${
                              entry.status.tone === 'great'
                                ? 'text-emerald-700'
                                : entry.status.tone === 'bad'
                                  ? 'text-destructive'
                                  : 'text-muted-foreground'
                            }`}
                          >
                            · {entry.status.label}
                          </span>{' '}
                          <span className="text-xs text-muted-foreground">
                            · {timeAgo(entry.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                  {selected.active && (
                    <Button
                      size="sm"
                      onClick={() => onRequestChange(selected.employeeNumber)}
                      data-testid="person-request-change"
                    >
                      Request a change
                    </Button>
                  )}
                  {selected.active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy}
                      onClick={() => void handleArchive(selected)}
                      data-testid="person-archive"
                    >
                      Archive
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
