import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  User,
  Search,
  DollarSign,
  Building2,
  MapPin,
  CreditCard,
  CheckCircle2,
  ChevronRight,
  ArrowLeft,
  Loader2,
  Calendar,
} from 'lucide-react';

import { fetchEmployeesPage } from '../api/employees';
import { submitEvent } from '../api/events';
import { ApiError, NetworkError } from '../api/client';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  changeTypeLabel,
  describeRequestedChange,
} from '../lib/humanize';
import type { Employee, EventType } from '../lib/types';

const errorOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof NetworkError
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Request failed';

type ChangeKind = Extract<EventType, 'SALARY_CHANGE' | 'BANK_ACCOUNT_CHANGE' | 'ADDRESS_CHANGE' | 'DEPARTMENT_CHANGE'>;

/** The four change types in plain-language terms. */
const CHANGE_KINDS: Array<{
  kind: ChangeKind;
  title: string;
  blurb: string;
  icon: React.ReactNode;
  accentClass: string;
}> = [
  {
    kind: 'SALARY_CHANGE',
    title: 'Salary',
    blurb: 'Update annual compensation',
    icon: <DollarSign size={22} />,
    accentClass: 'text-emerald-600 bg-emerald-500/12 border-emerald-500/25',
  },
  {
    kind: 'BANK_ACCOUNT_CHANGE',
    title: 'Bank account',
    blurb: 'Change where pay is deposited',
    icon: <CreditCard size={22} />,
    accentClass: 'text-blue-600 bg-blue-500/12 border-blue-500/25',
  },
  {
    kind: 'ADDRESS_CHANGE',
    title: 'Address',
    blurb: 'Update their residential address',
    icon: <MapPin size={22} />,
    accentClass: 'text-purple-600 bg-purple-500/12 border-purple-500/25',
  },
  {
    kind: 'DEPARTMENT_CHANGE',
    title: 'Department',
    blurb: 'Move them within the organization',
    icon: <Building2 size={22} />,
    accentClass: 'text-amber-600 bg-amber-500/12 border-amber-500/25',
  },
];

const FIELD_LABELS: Record<string, { label: string; placeholder?: string }> = {
  newSalary: { label: 'New annual salary', placeholder: '75000' },
  currency: { label: 'Currency (ISO code)', placeholder: 'EUR' },
  iban: { label: 'IBAN', placeholder: 'DE89370400440532013000' },
  street: { label: 'Street address', placeholder: 'Main St 12' },
  city: { label: 'City', placeholder: 'Berlin' },
  postalCode: { label: 'Postal code', placeholder: '10115' },
  country: { label: 'Country (ISO code)', placeholder: 'DE' },
  department: { label: 'New department', placeholder: 'Engineering' },
  newDepartment: { label: 'New department', placeholder: 'Engineering' },
};

const STEP_TITLES = ['Select person', 'Change type', 'Details', 'Review & submit'] as const;

function getInitials(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback.slice(0, 2).toUpperCase();
  return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
}

/**
 * The change-request wizard: pick a person, pick what to change, fill in
 * the details, review in plain language, and submit. All business logic is
 * API-driven — no simulation or demo overrides.
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
        if (pre) {
          setSelectedEmployee(pre);
        }
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
    (step === 2 &&
      payload !== null &&
      Object.entries(values)
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
    try {
      const result = await submitEvent({
        eventType: kind,
        payload: payload as never,
      });
      setSubmittedId(result.response.id);
      onSubmitted?.();
    } catch (err) {
      setSubmitError(errorOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Success state
  if (submittedId) {
    return (
      <section className="mx-auto max-w-lg space-y-6 py-12 text-center" data-testid="request-done">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/15">
          <CheckCircle2 size={40} className="text-emerald-600" />
        </div>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Request submitted</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The change is now in the processing pipeline. Head to Change Requests to
            track its lifecycle from queued through to applied.
          </p>
        </div>
        <Button
          size="lg"
          onClick={() => onSubmitted?.()}
          data-testid="request-done-continue"
          className="gap-2"
        >
          View change requests
          <ChevronRight size={16} />
        </Button>
      </section>
    );
  }

  const fieldsForKind =
    kind === 'SALARY_CHANGE'
      ? ['newSalary', 'currency', 'effectiveDate']
      : kind === 'BANK_ACCOUNT_CHANGE'
        ? ['iban', 'effectiveDate']
        : kind === 'ADDRESS_CHANGE'
          ? ['street', 'city', 'postalCode', 'country', 'effectiveDate']
          : ['newDepartment', 'effectiveDate'];

  return (
    <section className="mx-auto max-w-2xl space-y-8" data-testid="request-change-view">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Request a change</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Tell us who changes what — we track it end to end.
        </p>
      </div>

      {/* Step progress */}
      <div className="flex items-center gap-2" data-testid="wizard-progress">
        {STEP_TITLES.map((title, index) => (
          <div key={title} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all duration-200 ${
                index < step
                  ? 'border-primary bg-primary text-primary-foreground'
                  : index === step
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground'
              }`}
            >
              {index < step ? <CheckCircle2 size={14} /> : index + 1}
            </div>
            <span
              className={`hidden text-xs sm:block ${
                index === step ? 'font-semibold text-foreground' : 'text-muted-foreground'
              }`}
            >
              {title}
            </span>
            {index < STEP_TITLES.length - 1 && (
              <div
                className={`h-px flex-1 transition-colors duration-300 ${
                  index < step ? 'bg-primary' : 'bg-border'
                }`}
                aria-hidden
              />
            )}
          </div>
        ))}
      </div>

      {loadError && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3">
          <p className="text-sm text-destructive">{loadError}</p>
        </div>
      )}

      {/* STEP 1 — Select person */}
      {step === 0 && (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <h2 className="font-semibold">Who is this change for?</h2>
          <Input
            label="Search employees"
            value={search}
            onChange={setSearch}
            placeholder="Search by name or employee number…"
            leftIcon={<Search size={16} />}
            data-testid="wizard-search"
          />
          <ul className="max-h-72 space-y-1.5 overflow-y-auto" data-testid="wizard-people">
            {loadingEmployees && (
              <li className="space-y-2 py-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 rounded-xl border border-border p-3">
                    <div className="skeleton h-9 w-9 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <div className="skeleton h-4 w-28 rounded" />
                      <div className="skeleton h-3 w-20 rounded" />
                    </div>
                  </div>
                ))}
              </li>
            )}
            {!loadingEmployees && filtered.map((employee) => (
              <li key={employee.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all duration-150 ${
                    selectedEmployee?.id === employee.id
                      ? 'border-primary/50 bg-primary/8 shadow-sm'
                      : 'border-transparent bg-muted/40 hover:border-border hover:bg-muted/60'
                  }`}
                  onClick={() => setSelectedEmployee(employee)}
                  data-testid={`wizard-person-${employee.employeeNumber}`}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {getInitials(employee.name, employee.employeeNumber)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{employee.name ?? '(unnamed)'}</div>
                    <div className="text-xs text-muted-foreground">
                      {employee.employeeNumber}
                      {employee.department ? ` · ${employee.department}` : ''}
                    </div>
                  </div>
                  {selectedEmployee?.id === employee.id && (
                    <CheckCircle2 size={16} className="shrink-0 text-primary" />
                  )}
                </button>
              </li>
            ))}
            {!loadingEmployees && filtered.length === 0 && (
              <li className="py-6 text-center">
                <User size={28} className="mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No employees found. Add people on the People page first.
                </p>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* STEP 2 — Change type */}
      {step === 1 && (
        <div className="space-y-4">
          <h2 className="font-semibold">What needs to change?</h2>
          <div className="grid grid-cols-2 gap-3" data-testid="wizard-kinds">
            {CHANGE_KINDS.map(({ kind: k, title, blurb, icon, accentClass }) => (
              <button
                key={k}
                type="button"
                className={`group flex flex-col gap-3 rounded-2xl border-2 p-5 text-left transition-all duration-200 ${
                  kind === k
                    ? `${accentClass} shadow-sm`
                    : 'border-border bg-card hover:border-primary/25 hover:shadow-sm'
                }`}
                onClick={() => setKind(k)}
                data-testid={`wizard-kind-${k}`}
              >
                <div className={`inline-flex rounded-xl p-2.5 ${kind === k ? '' : 'bg-muted'}`}>
                  {icon}
                </div>
                <div>
                  <div className="font-semibold">{title}</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">{blurb}</div>
                </div>
                {kind === k && (
                  <CheckCircle2 size={16} className="ml-auto self-end" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* STEP 3 — Details */}
      {step === 2 && kind && (
        <form
          className="space-y-5 rounded-2xl border border-border bg-card p-6"
          onSubmit={handleDetail}
          data-testid="wizard-details"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {getInitials(selectedEmployee?.name, selectedEmployee?.employeeNumber ?? '')}
            </div>
            <div>
              <p className="font-semibold">{selectedEmployee?.name ?? selectedEmployee?.employeeNumber}</p>
              <p className="text-xs text-muted-foreground">{changeTypeLabel(kind)}</p>
            </div>
          </div>

          <div className="h-px bg-border" />

          {fieldsForKind.map((field) => (
            <div key={field}>
              {field === 'effectiveDate' ? (
                <Input
                  label="Effective date"
                  type="date"
                  value={values.effectiveDate ?? ''}
                  onChange={(next) =>
                    setValues((prev) => ({ ...prev, effectiveDate: next }))
                  }
                  leftIcon={<Calendar size={15} />}
                  data-testid="wizard-effective-date"
                />
              ) : field === 'newSalary' ? (
                <Input
                  label={FIELD_LABELS[field].label}
                  type="number"
                  value={values[field] ?? ''}
                  onChange={(next) => setValues((prev) => ({ ...prev, [field]: next }))}
                  placeholder={FIELD_LABELS[field].placeholder}
                  leftIcon={<DollarSign size={15} />}
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

      {/* STEP 4 — Review */}
      {step === 3 && kind && payload && selectedEmployee && (
        <div className="space-y-5 rounded-2xl border border-border bg-card p-6" data-testid="wizard-review">
          <div>
            <h2 className="font-semibold">Review your request</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Confirm the details before submitting.
            </p>
          </div>

          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
            <p className="text-sm leading-relaxed">
              <span className="font-semibold text-foreground">
                {selectedEmployee.name ?? selectedEmployee.employeeNumber}
              </span>{' '}
              <span className="text-muted-foreground">({selectedEmployee.employeeNumber}):</span>{' '}
              {describeRequestedChange(kind, payload)}.
            </p>
          </div>

          {/* Summary grid */}
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/40 p-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Employee</p>
              <p className="mt-0.5 font-medium">{selectedEmployee.name ?? selectedEmployee.employeeNumber}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Change type</p>
              <p className="mt-0.5 font-medium">{changeTypeLabel(kind)}</p>
            </div>
            {values.effectiveDate && (
              <div>
                <p className="text-xs text-muted-foreground">Effective date</p>
                <p className="mt-0.5 font-medium">{values.effectiveDate}</p>
              </div>
            )}
          </div>

          {submitError && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3">
              <p className="text-sm text-destructive" role="alert" data-testid="wizard-submit-error">
                {submitError}
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep(2)}
              className="gap-1.5"
            >
              <ArrowLeft size={14} />
              Back
            </Button>
            <Button
              size="sm"
              disabled={submitting}
              onClick={() => void handleSubmit()}
              data-testid="wizard-submit"
              className="gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Submitting…
                </>
              ) : (
                'Submit request'
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Navigation — Next/Back (steps 0–2) */}
      {step < 3 && (
        <div className="flex gap-3">
          {step > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep(step - 1)}
              className="gap-1.5"
            >
              <ArrowLeft size={14} />
              Back
            </Button>
          )}
          <Button
            size="sm"
            disabled={!canNext}
            onClick={() => setStep(step + 1)}
            data-testid="wizard-next"
            className="gap-1.5"
          >
            Next
            <ChevronRight size={14} />
          </Button>
        </div>
      )}
    </section>
  );
}
