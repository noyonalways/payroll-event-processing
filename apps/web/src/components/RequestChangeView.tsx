import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { fetchEmployeesPage } from '../api/employees';
import { submitEvent } from '../api/events';
import { ApiError, NetworkError } from '../api/client';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select';
import {
  changeTypeLabel,
  describeRequestedChange,
  formatMoney,
} from '../lib/humanize';
import type { Employee, EventType } from '../lib/types';

const errorOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof NetworkError
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Request failed';

type ChangeKind = Extract<EventType, 'SALARY_CHANGE' | 'BANK_ACCOUNT_CHANGE' | 'ADDRESS_CHANGE' | 'DEPARTMENT_CHANGE'>;

/** The four changes a payroll person actually makes, in plain words. */
const CHANGE_KINDS: Array<{
  kind: ChangeKind;
  title: string;
  blurb: string;
  emoji: string;
}> = [
  { kind: 'SALARY_CHANGE', title: 'Salary', blurb: 'Change what someone is paid', emoji: '💰' },
  { kind: 'BANK_ACCOUNT_CHANGE', title: 'Bank account', blurb: 'Where their pay goes', emoji: '🏦' },
  { kind: 'ADDRESS_CHANGE', title: 'Address', blurb: 'Where they live', emoji: '🏠' },
  { kind: 'DEPARTMENT_CHANGE', title: 'Department', blurb: 'Where they sit in the org', emoji: '🧭' },
];

const FIELD_LABELS: Record<string, { label: string; placeholder?: string }> = {
  newSalary: { label: 'New salary (annual)' },
  currency: { label: 'Currency', placeholder: 'EUR' },
  iban: { label: 'New bank account (IBAN)', placeholder: 'DE89370400440532013000' },
  street: { label: 'Street', placeholder: 'Main St 12' },
  city: { label: 'City', placeholder: 'Berlin' },
  postalCode: { label: 'Postal code', placeholder: '10115' },
  country: { label: 'Country', placeholder: 'DE' },
  department: { label: 'New department', placeholder: 'Engineering' },
};

const STEP_TITLES = ['Who', 'What', 'Details', 'Review'] as const;

/**
 * The change-request wizard (frontend-app rework, step 4 of the real-user
 * journey): pick a person, pick what to change, fill friendly details, review
 * in one sentence, submit. Simulation scenarios (the EMP-DEMO-* demo levers)
 * live behind a collapsed "Simulation" disclosure so real use is unaffected.
 */
export function RequestChangeView({
  prefillEmployeeNumber,
  onSubmitted,
}: {
  prefillEmployeeNumber?: string | null;
  onSubmitted?: () => void;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<ChangeKind | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [simulation, setSimulation] = useState<'none' | string>('none');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingEmployees(true);
    fetchEmployeesPage({ limit: 100 })
      .then((page) => {
        if (cancelled) return;
        const active = page.data.filter((e) => e.active);
        setEmployees(active);
        const pre = active.find((e) => e.employeeNumber === prefillEmployeeNumber);
        if (pre) setSelectedEmployee(pre);
      })
      .catch((err) => !cancelled && setLoadError(errorOf(err)))
      .finally(() => !cancelled && setLoadingEmployees(false));
    return () => {
      cancelled = true;
    };
  }, [prefillEmployeeNumber]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return employees;
    return employees.filter(
      (e) =>
        e.name?.toLowerCase().includes(query) ||
        e.employeeNumber.toLowerCase().includes(query),
    );
  }, [employees, search]);

  const payload = useMemo(() => {
    if (!kind || !selectedEmployee) return null;
    const base: Record<string, string> = {
      employeeId: selectedEmployee.employeeNumber,
      effectiveDate: values.effectiveDate ?? '',
    };
    for (const key of Object.keys(values)) {
      if (key !== 'effectiveDate' && values[key] !== undefined) {
        base[key] = values[key];
      }
    }
    return base;
  }, [kind, selectedEmployee, values]);

  const canNext =
    (step === 0 && selectedEmployee !== null) ||
    (step === 1 && kind !== null) ||
    (step === 2 && payload !== null && Object.entries(values)
      .filter(([key]) => key !== 'effectiveDate')
      .every(([, v]) => v.trim() !== '') &&
      (values.effectiveDate ?? '') !== '');

  function handleDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canNext) setStep(3);
  }

  async function handleSubmit() {
    if (!kind || !payload) return;
    setSubmitting(true);
    setSubmitError(null);
    // Simulation levers submit for the reserved EMP-DEMO-* id, which forces
    // the outcome server-side; real users never touch this disclosure.
    const simulationId =
      simulation === 'none'
        ? null
        : ({
            success: 'EMP-DEMO-SUCCESS',
            'retry-recover': 'EMP-DEMO-RECOVER',
            'retry-fail': 'EMP-DEMO-TRANSIENT',
            'fail-after-retries': 'EMP-DEMO-FAILAFTER',
            permanent: 'EMP-DEMO-PERMANENT',
            random: null,
          }[simulation] ?? null);
    try {
      const result = await submitEvent({
        eventType: kind,
        payload: {
          ...payload,
          employeeId: simulationId ?? payload.employeeId,
        } as never,
      });
      setSubmittedId(result.response.id);
      onSubmitted?.();
    } catch (err) {
      setSubmitError(errorOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (submittedId) {
    return (
      <section className="mx-auto max-w-xl space-y-4 text-center" data-testid="request-done">
        <div className="text-4xl">✅</div>
        <h2 className="text-xl font-semibold tracking-tight">Request submitted</h2>
        <p className="text-sm text-muted-foreground">
          The change is in the pipeline. You can watch it move through — and get
          the outcome — on the change requests page.
        </p>
        <Button size="sm" onClick={() => onSubmitted?.()} data-testid="request-done-continue">
          View my change requests
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-2xl space-y-5" data-testid="request-change-view">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Request a change</h2>
        <p className="text-sm text-muted-foreground">
          Tell us who changes what — we take it from there and track it end to end.
        </p>
      </div>

      {/* progress */}
      <div className="flex items-center gap-2" data-testid="wizard-progress">
        {STEP_TITLES.map((title, index) => (
          <div key={title} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                index < step || (index === step)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted text-muted-foreground'
              }`}
            >
              {index + 1}
            </span>
            <span
              className={`text-xs ${index === step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
            >
              {title}
            </span>
            {index < STEP_TITLES.length - 1 && (
              <span className="h-px flex-1 bg-border" aria-hidden />
            )}
          </div>
        ))}
      </div>

      {loadError && (
        <p className="text-sm text-destructive" role="alert">{loadError}</p>
      )}

      {/* STEP 1 — person */}
      {step === 0 && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <Input
            label="Find a person"
            value={search}
            onChange={setSearch}
            placeholder="Search name or employee number…"
            data-testid="wizard-search"
          />
          <ul className="max-h-64 space-y-1 overflow-auto" data-testid="wizard-people">
            {loadingEmployees && <li className="text-sm text-muted-foreground">Loading…</li>}
            {filtered.map((employee) => (
              <li key={employee.id}>
                <button
                  type="button"
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                    selectedEmployee?.id === employee.id
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-transparent hover:border-border hover:bg-muted/40'
                  }`}
                  onClick={() => setSelectedEmployee(employee)}
                  data-testid={`wizard-person-${employee.employeeNumber}`}
                >
                  <span className="font-medium">{employee.name ?? '(unnamed)'}</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    · {employee.employeeNumber}
                    {employee.department ? ` · ${employee.department}` : ''}
                  </span>
                </button>
              </li>
            ))}
            {!loadingEmployees && filtered.length === 0 && (
              <li className="text-sm text-muted-foreground">
                No match — add people on the People page first.
              </li>
            )}
          </ul>
        </div>
      )}

      {/* STEP 2 — what */}
      {step === 1 && (
        <div className="grid grid-cols-2 gap-3" data-testid="wizard-kinds">
          {CHANGE_KINDS.map(({ kind: k, title, blurb, emoji }) => (
            <button
              key={k}
              type="button"
              className={`rounded-xl border p-4 text-left transition-colors ${
                kind === k ? 'border-primary/50 bg-primary/5' : 'border-border bg-card hover:border-primary/20'
              }`}
              onClick={() => setKind(k)}
              data-testid={`wizard-kind-${k}`}
            >
              <div className="text-2xl">{emoji}</div>
              <div className="mt-1 font-medium">{title}</div>
              <div className="text-xs text-muted-foreground">{blurb}</div>
            </button>
          ))}
        </div>
      )}

      {/* STEP 3 — details */}
      {step === 2 && kind && (
        <form
          className="space-y-4 rounded-xl border border-border bg-card p-4"
          onSubmit={handleDetail}
          data-testid="wizard-details"
        >
          {(kind === 'SALARY_CHANGE'
            ? ['newSalary', 'currency', 'effectiveDate']
            : kind === 'BANK_ACCOUNT_CHANGE'
              ? ['iban', 'effectiveDate']
              : kind === 'ADDRESS_CHANGE'
                ? ['street', 'city', 'postalCode', 'country', 'effectiveDate']
                : ['department', 'effectiveDate']
          ).map((field) => (
            <div key={field}>
              {field === 'effectiveDate' ? (
                <>
                  <span className="mb-1 block text-sm font-medium">Effective date</span>
                  <input
                    type="date"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                    data-testid="wizard-effective-date"
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, effectiveDate: e.target.value }))
                    }
                  />
                </>
              ) : field === 'newSalary' ? (
                <Input
                  label={FIELD_LABELS[field].label}
                  type="number"
                  value={values[field] ?? ''}
                  onChange={(next) => setValues((prev) => ({ ...prev, [field]: next }))}
                  placeholder="75000"
                  data-testid={`wizard-field-${field}`}
                />
              ) : (
                <Input
                  label={FIELD_LABELS[field].label}
                  value={values[field] ?? ''}
                  onChange={(next) => setValues((prev) => ({ ...prev, [field]: next }))}
                  placeholder={FIELD_LABELS[field].placeholder}
                  data-testid={`wizard-field-${field}`}
                />
              )}
            </div>
          ))}
          <Button type="submit" size="sm" disabled={!canNext} data-testid="wizard-details-next">
            Review request
          </Button>
        </form>
      )}

      {/* STEP 4 — review */}
      {step === 3 && kind && payload && selectedEmployee && (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4" data-testid="wizard-review">
          <p className="text-sm">
            <span className="font-medium">
              {selectedEmployee.name ?? selectedEmployee.employeeNumber}
            </span>{' '}
            ({selectedEmployee.employeeNumber}): {describeRequestedChange(kind, payload)}.
          </p>
          <details className="rounded-md border border-border bg-muted/30 p-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Simulation (demo environments only)
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              Submitting for a reserved demo employee id forces a specific outcome
              server-side. Real requests leave this on “No simulation”.
            </p>
            <Select
              value={simulation}
              onValueChange={(v) => setSimulation(v)}
              data-testid="wizard-simulation"
            >
              <SelectTrigger className="mt-2 w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No simulation — process normally</SelectItem>
                <SelectItem value="success">Demo: always succeed</SelectItem>
                <SelectItem value="retry-recover">Demo: fail twice, then succeed</SelectItem>
                <SelectItem value="retry-fail">Demo: keep failing (retries)</SelectItem>
                <SelectItem value="fail-after-retries">Demo: fail after retries</SelectItem>
                <SelectItem value="permanent">Demo: permanent rejection</SelectItem>
              </SelectContent>
            </Select>
          </details>
          {submitError && (
            <p className="text-sm text-destructive" role="alert" data-testid="wizard-submit-error">
              {submitError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button size="sm" disabled={submitting} onClick={() => void handleSubmit()} data-testid="wizard-submit">
              {submitting ? 'Submitting…' : 'Submit request'}
            </Button>
          </div>
        </div>
      )}

      {/* navigation — Next visible from step 0; Back hidden on the first step */}
      {step < 3 && (
        <div className="flex gap-2">
          {step > 0 && (
            <Button variant="outline" size="sm" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <Button size="sm" disabled={!canNext} onClick={() => setStep(step + 1)} data-testid="wizard-next">
            Next: {STEP_TITLES[step + 1]}
          </Button>
        </div>
      )}
    </section>
  );
}
