import { useState } from 'react';
import type { FormEvent } from 'react';

import { Input } from '@/components/motion/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select';
import { Button } from '@/components/ui/button';

import { ApiError, NetworkError, submitEvent } from '../api/events';
import {
  buildPayload,
  fieldsFor,
  validateValues,
} from '../lib/eventTypes';
import {
  DEFAULT_SCENARIO_ID,
  DEMO_SCENARIOS,
  nextValues,
  scenarioById,
} from '../lib/scenarios';
import type { DemoScenarioId } from '../lib/scenarios';
import type { RecordSubmissionInput } from '../lib/useEventTracker';
import { EVENT_TYPES } from '../lib/types';
import type { EventSubmissionResponse, EventType } from '../lib/types';

export interface SubmitFormProps {
  /** Called with the created event details so the tracker can persist them. */
  onSubmitted: (submission: RecordSubmissionInput) => void;
}

/**
 * Per-type submission form. Fields come from `eventTypes.ts` (the single
 * source for the `event-submission` contract) and are pre-filled with sample
 * values that pass API validation, so a reviewer can submit immediately or
 * tweak a single field. Client-side checks block obviously incomplete
 * submissions; the API stays the authority — a structured 400 is surfaced
 * inline without losing the entered values. Every submit uses a fresh
 * `crypto.randomUUID()` as the `Idempotency-Key`, and a 201 adds the event
 * (with its key) to the tracker and displays the returned id/status.
 */
export function SubmitForm({ onSubmitted }: SubmitFormProps) {
  const [eventType, setEventType] = useState<EventType>('BANK_ACCOUNT_CHANGE');
  const [scenario, setScenario] = useState<DemoScenarioId>(DEFAULT_SCENARIO_ID);
  const [values, setValues] = useState<Record<string, string>>(() =>
    nextValues('BANK_ACCOUNT_CHANGE', DEFAULT_SCENARIO_ID),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<EventSubmissionResponse | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  function updateValue(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setApiError(null);
    setErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function handleReset() {
    setValues(nextValues(eventType, scenario));
    setErrors({});
    setApiError(null);
    setLastResult(null);
  }

  function handleTypeChange(value: string) {
    // The select is built from EVENT_TYPES, so the string is always a valid
    // EventType; defaulting keeps the invariant even if it somehow isn't.
    const next = (EVENT_TYPES as readonly string[]).includes(value)
      ? (value as EventType)
      : 'BANK_ACCOUNT_CHANGE';
    setEventType(next);
    setValues(nextValues(next, scenario));
    setErrors({});
    setApiError(null);
    setLastResult(null);
  }

  function handleScenarioChange(value: string) {
    // The select is built from DEMO_SCENARIOS, so the string is always a valid
    // DemoScenarioId; defaulting keeps the invariant even if it somehow isn't.
    const next = DEMO_SCENARIOS.some((s) => s.id === value)
      ? (value as DemoScenarioId)
      : DEFAULT_SCENARIO_ID;
    setScenario(next);
    setValues(nextValues(eventType, next));
    setErrors({});
    setApiError(null);
    setLastResult(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validationErrors = validateValues(eventType, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    const idempotencyKey = crypto.randomUUID();
    const payload = buildPayload(eventType, values);
    setSubmitting(true);
    setApiError(null);
    try {
      const { response } = await submitEvent({ eventType, payload }, idempotencyKey);
      setLastResult(response);
      // Back to a ready-to-submit state: the next event can be submitted
      // immediately, and changing one or two fields is a trivial tweak. The
      // demo scenario is preserved so repeated runs demo the same case.
      setValues(nextValues(eventType, scenario));
      onSubmitted({
        id: response.id,
        eventType,
        employeeId: payload.employeeId,
        idempotencyKey,
      });
    } catch (err) {
      setApiError(
        err instanceof ApiError || err instanceof NetworkError
          ? err.message
          : 'Unexpected error while submitting the event',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Submit an event</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pre-filled sample values — pick a demo scenario, tweak a field, then
            submit. A structured 400 from the API is surfaced inline.
          </p>
          {lastResult && (
            <p className="mt-1.5 truncate text-xs text-emerald-700 dark:text-emerald-300">
              Created <span className="font-mono">{lastResult.id}</span> ·{' '}
              {lastResult.status}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          title="Restore the sample values"
        >
          Reset
        </Button>
      </div>

      {apiError && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {apiError}
        </p>
      )}

      <div>
        <span className="px-1 text-sm font-medium text-foreground">
          Event type
        </span>
        <Select value={eventType} onValueChange={handleTypeChange}>
          <SelectTrigger data-testid="event-type-trigger" className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENT_TYPES.map((type) => (
              <SelectItem
                key={type}
                value={type}
                data-testid={`event-type-option-${type}`}
              >
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3">
        <span className="px-1 text-sm font-medium text-foreground">
          Demo scenario
        </span>
        <Select value={scenario} onValueChange={handleScenarioChange}>
          <SelectTrigger data-testid="scenario-trigger" className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEMO_SCENARIOS.map((demo) => (
              <SelectItem
                key={demo.id}
                value={demo.id}
                data-testid={`scenario-option-${demo.id}`}
              >
                {demo.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1.5 px-1 text-xs text-muted-foreground">
          {scenarioById(scenario).description}
        </p>
      </div>

      {fieldsFor(eventType).map((spec) => {
        const value = values[spec.name] ?? '';
        const empty = value.trim() === '';
        return (
          <div key={spec.name} className="mt-3">
            <Input
              type={
                spec.kind === 'date'
                  ? 'date'
                  : spec.kind === 'number'
                    ? 'number'
                    : 'text'
              }
              min={spec.kind === 'number' ? '0' : undefined}
              label={spec.label}
              value={value}
              onChange={(next) => updateValue(spec.name, next)}
              error={errors[spec.name]}
              success={!errors[spec.name] && !empty}
            />
          </div>
        );
      })}

      <Button
        type="submit"
        disabled={submitting}
        size="lg"
        className="mt-4 w-full shadow-sm"
      >
        {submitting ? 'Submitting…' : 'Submit event'}
      </Button>
    </form>
  );
}