import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, NetworkError } from '../api/employees';
import {
  archiveEmployee,
  createEmployee,
  updateEmployee,
} from '../api/employees';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select';
import { useEmployees } from '../lib/useEmployees';
import type { Employee } from '../lib/types';

/** Digits-and-dashes time label for the created column (no timezone theatrics). */
const createdLabel = (iso: string) => iso.slice(0, 10);

const errorOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof NetworkError
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Request failed';

/**
 * The organization's employee directory (employee-directory, frontend-app):
 * one server-driven table — register, correct, archive — over `GET /employees`
 * with the `active` filter, a search box, and load-more pagination. Rows are
 * never invented locally: every mutation re-fetches page one through the
 * directory hook, so what the server holds is exactly what is shown, and a
 * different organization signing in sees only its own roster.
 */
export function EmployeesView() {
  const directory = useEmployees();
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  /** The row in inline-edit mode (its number identifies it — ids feel alien here). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{ name: string; department: string }>({
    name: '',
    department: '',
  });

  const [form, setForm] = useState({ employeeNumber: '', name: '', department: '' });
  const formFilled = useMemo(
    () => form.employeeNumber.trim() !== '' && form.name.trim() !== '',
    [form],
  );

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setActionError(null);
    try {
      const department = form.department.trim();
      await createEmployee({
        employeeNumber: form.employeeNumber.trim(),
        name: form.name.trim(),
        ...(department ? { department } : {}),
      });
      // Blank the form but KEEP it mounted: the values that made it through
      // were valid, and the next registration starts uncluttered; a rejected
      // one never blanked anything to begin with.
      setForm({ employeeNumber: '', name: '', department: '' });
      await directory.refresh();
    } catch (error) {
      // Structured 400/409 surfacing with the entered values fully intact.
      setActionError(
        error instanceof ApiError || error instanceof NetworkError
          ? error.message
          : 'Registration failed',
      );
    } finally {
      setCreating(false);
    }
  }

  function beginEdit(employee: Employee) {
    setEditingId(employee.id);
    setActionError(null);
    setEditValues({ name: employee.name ?? '', department: employee.department ?? '' });
  }

  async function handleEditSave(id: string) {
    setArchivingId(id);
    setActionError(null);
    try {
      const department = editValues.department.trim();
      await updateEmployee(id, {
        name: editValues.name.trim(),
        ...(department ? { department } : {}),
      });
      setEditingId(null);
      await directory.refresh();
    } catch (error) {
      setActionError(errorOf(error));
    } finally {
      setArchivingId(null);
    }
  }

  async function handleArchive(employee: Employee) {
    const label = employee.name ? `${employee.employeeNumber} (${employee.name})` : employee.employeeNumber;
    // Archive means: the record stays, the number stays reserved, the history
    // stays readable — say so where a plain "Delete?" would scare people.
    if (!window.confirm(`Archive ${label}? Their event history is kept and the number stays reserved.`)) {
      return;
    }
    setArchivingId(employee.id);
    setActionError(null);
    try {
      await archiveEmployee(employee.id);
      await directory.refresh();
    } catch (error) {
      setActionError(errorOf(error));
    } finally {
      setArchivingId(null);
    }
  }

  async function handleReactivate(employee: Employee) {
    setArchivingId(employee.id);
    setActionError(null);
    try {
      await updateEmployee(employee.id, { active: true });
      await directory.refresh();
    } catch (error) {
      setActionError(errorOf(error));
    } finally {
      setArchivingId(null);
    }
  }

  return (
    <div className="space-y-5" aria-label="Employee directory">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Employees</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The organization's roster. Every submitted event references one of
          these records by employee number; archiving keeps the history and
          reserves the number.
        </p>
      </div>

      {actionError && (
        <div
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="employee-action-error"
        >
          <span>{actionError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setActionError(null)}
          >
            dismiss
          </Button>
        </div>
      )}

      {/* Registration — server errors surface inline, entered values stay. */}
      <form
        onSubmit={(event) => void handleCreate(event)}
        className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm"
        data-testid="employee-create-form"
      >
        <p className="mb-3 text-sm font-medium">Register an employee</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Employee number"
            value={form.employeeNumber}
            onChange={(next) => setForm((prev) => ({ ...prev, employeeNumber: next }))}
            placeholder="emp-007"
            data-testid="employee-number-input"
          />
          <Input
            label="Name"
            value={form.name}
            onChange={(next) => setForm((prev) => ({ ...prev, name: next }))}
            placeholder="Ada Lovelace"
            data-testid="employee-name-input"
          />
          <Input
            label="Department (optional)"
            value={form.department}
            onChange={(next) => setForm((prev) => ({ ...prev, department: next }))}
            placeholder="Engineering"
            data-testid="employee-department-input"
          />
        </div>
        <Button
          type="submit"
          disabled={creating || !formFilled}
          size="sm"
          className="mt-3"
          data-testid="employee-create-submit"
        >
          {creating ? 'Registering…' : 'Register employee'}
        </Button>
      </form>

      {/* Filters: active state + search, both server-side (`active`+`search`). */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={directory.activeFilter}
          onValueChange={(next) =>
            directory.setActiveFilter(
              next === 'active' || next === 'archived' ? next : 'all',
            )
          }
        >
          <SelectTrigger data-testid="employee-active-trigger" className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" data-testid="employee-active-all">
              All employees
            </SelectItem>
            <SelectItem value="active" data-testid="employee-active-active">
              Active only
            </SelectItem>
            <SelectItem value="archived" data-testid="employee-active-archived">
              Archived only
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          label=""
          value={directory.search}
          onChange={(next) => directory.setSearch(next)}
          placeholder="Search number or name…"
          data-testid="employee-search-input"
        />
      </div>

      {directory.loadError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {directory.loadError}
        </p>
      )}

      {directory.loading ? (
        <p
          className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
          data-testid="employee-directory-loading"
        >
          Loading directory…
        </p>
      ) : directory.rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
          data-testid="employee-directory-empty"
        >
          No employees match the current view — adjust the filters or register
          someone above. The directory is served by the API, so it is exactly
          what this organization holds.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Employee directory rows" data-testid="employee-rows">
          {directory.rows.map((employee) =>
            editingId === employee.id ? (
              <li
                key={employee.id}
                className="rounded-lg border border-border bg-card p-3 shadow-sm"
                data-testid={`employee-edit-${employee.employeeNumber}`}
              >
                <div className="flex flex-wrap items-end gap-2">
                  <span className="rounded bg-muted px-2 py-1 font-mono text-xs" data-testid="employee-edit-number">
                    {employee.employeeNumber}
                  </span>
                  <div className="min-w-[140px] flex-1">
                    <Input
                      label="Name"
                      value={editValues.name}
                      onChange={(next) => setEditValues((prev) => ({ ...prev, name: next }))}
                      data-testid="employee-edit-name"
                    />
                  </div>
                  <div className="min-w-[140px] flex-1">
                    <Input
                      label="Department"
                      value={editValues.department}
                      onChange={(next) =>
                        setEditValues((prev) => ({ ...prev, department: next }))
                      }
                      data-testid="employee-edit-department"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={archivingId === employee.id}
                      onClick={() => void handleEditSave(employee.id)}
                      data-testid="employee-edit-save"
                    >
                      {archivingId === employee.id ? 'Saving…' : 'Save'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingId(null)}
                      data-testid="employee-edit-cancel"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </li>
            ) : (
              <li
                key={employee.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-sm"
                data-testid={`employee-row-${employee.employeeNumber}`}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className="rounded bg-muted px-2 py-1 font-mono text-xs"
                    data-testid="employee-row-number"
                  >
                    {employee.employeeNumber}
                  </span>
                  <span className="font-medium" data-testid="employee-row-name">
                    {employee.name ?? <span className="italic text-muted-foreground">—</span>}
                  </span>
                  {employee.department && (
                    <span className="text-muted-foreground" data-testid="employee-row-department">
                      · {employee.department}
                    </span>
                  )}
                  <span
                    className={
                      employee.active
                        ? 'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300'
                        : 'rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground'
                    }
                    data-testid="employee-row-active"
                  >
                    {employee.active ? 'active' : 'archived'}
                  </span>
                  <span className="text-xs text-muted-foreground" data-testid="employee-row-created">
                    since {createdLabel(employee.createdAt)}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={archivingId === employee.id}
                    onClick={() => beginEdit(employee)}
                    data-testid={`employee-edit-${employee.id}`}
                  >
                    Edit
                  </Button>
                  {employee.active ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={archivingId === employee.id}
                      onClick={() => void handleArchive(employee)}
                      data-testid={`employee-archive-${employee.id}`}
                    >
                      {archivingId === employee.id ? 'Working…' : 'Archive'}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={archivingId === employee.id}
                      onClick={() => void handleReactivate(employee)}
                      data-testid={`employee-reactivate-${employee.id}`}
                    >
                      Reactivate
                    </Button>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {directory.hasMore && !directory.loading && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => void directory.loadMore()}
          disabled={directory.loadingMore}
          data-testid="employee-load-more"
        >
          {directory.loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
