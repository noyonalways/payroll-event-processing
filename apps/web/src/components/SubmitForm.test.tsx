import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubmitForm } from './SubmitForm';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

/**
 * The directory the picker renders from (the seeded demo employees plus one
 * plain row) — served for every GET /employees; POST /events falls through to
 * the per-test override (or a default 201).
 */
const employeesPage = {
  data: (
    [
      ['EMP-DEMO-SUCCESS', 'Demo employee (success)'],
      ['EMP-DEMO-RECOVER', 'Demo employee (recover)'],
      ['EMP-DEMO-TRANSIENT', 'Demo employee (transient)'],
      ['EMP-DEMO-FAILAFTER', 'Demo employee (fail-after-retries)'],
      ['EMP-DEMO-PERMANENT', 'Demo employee (permanent)'],
      ['emp-1', 'Ada Lovelace'],
    ] as const
  ).map(([employeeNumber, name], i) => ({
    id: `emp-row-${i}`,
    employeeNumber,
    name,
    department: 'Demo',
    active: true,
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt: '2026-10-16T09:00:00.000Z',
  })),
  nextCursor: null,
  limit: 100,
};

function defaultRoute(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  if (u.includes('/employees')) return Promise.resolve(jsonResponse(employeesPage));
  return Promise.resolve(jsonResponse({ id: 'evt-default', status: 'received' }, 201));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(defaultRoute);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The picker's trigger carries the SELECTED employee (Radix shows its label). */
const pickerTrigger = () => screen.getByTestId('employee-picker-trigger');

/**
 * Selects `emp-1` through the directory picker (real picker interaction, not
 * input typing — the field no longer accepts free text), then fills the rest
 * of the BANK_ACCOUNT_CHANGE fields.
 */
async function fillBankFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(pickerTrigger());
  await user.click(screen.getByTestId('employee-picker-option-emp-1'));

  fireEvent.change(screen.getByLabelText(/effective date/i), {
    target: { value: '2026-09-01' },
  });

  const ibanInput = screen.getByLabelText(/iban/i);
  await user.clear(ibanInput);
  await user.type(ibanInput, 'DE89370400440532013000');
}

describe('SubmitForm', () => {
  it('renders the BANK_ACCOUNT_CHANGE fields with the directory-backed employee picker', () => {
    render(<SubmitForm onSubmitted={vi.fn()} />);

    expect(pickerTrigger()).toBeInTheDocument();
    expect(screen.getByLabelText(/effective date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/iban/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/new salary/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/street/i)).not.toBeInTheDocument();
    // No free-text employee id input exists anymore.
    expect(screen.queryByLabelText(/employee id/i)).not.toBeInTheDocument();
  });

  it('pre-fills the picker with the scenario demo employee that the directory lists', async () => {
    render(<SubmitForm onSubmitted={vi.fn()} />);

    // The default scenario's employee is an ACTIVE directory member, so the
    // trigger shows it without any user action.
    expect(await screen.findByTestId('employee-picker-option-EMP-DEMO-SUCCESS')).toBeTruthy();
    expect(pickerTrigger()).toHaveTextContent(/EMP-DEMO-SUCCESS/);
    expect(screen.getByLabelText(/effective date/i)).toHaveValue('2026-09-01');
    expect(screen.getByLabelText(/iban/i)).toHaveValue('DE89370400440532013000');
  });

  it('swaps the rendered fields and their defaults when the event type changes', async () => {
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={vi.fn()} />);

    await user.click(screen.getByTestId('event-type-trigger'));
    await user.click(screen.getByTestId('event-type-option-ADDRESS_CHANGE'));

    expect(screen.getByLabelText(/street/i)).toHaveValue('Hauptstraße 1');
    expect(screen.getByLabelText(/city/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/postal code/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/country/i)).toHaveValue('DE');
    expect(screen.queryByLabelText(/iban/i)).not.toBeInTheDocument();
    // The selected demo scenario (and its directory employee) is preserved.
    expect(pickerTrigger()).toHaveTextContent(/EMP-DEMO-SUCCESS/);
  });

  it('submits immediately with the pre-filled defaults (no typing)', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={onSubmitted} />);

    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByText(/evt-default/)).toBeInTheDocument();
    expect(onSubmitted).toHaveBeenCalledTimes(1);

    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === 'POST');
    expect(posts).toHaveLength(1);
    const body = JSON.parse((posts[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      eventType: 'BANK_ACCOUNT_CHANGE',
      payload: {
        employeeId: 'EMP-DEMO-SUCCESS',
        effectiveDate: '2026-09-01',
        iban: 'DE89370400440532013000',
      },
    });
  });

  it('blocks a submit with a cleared required field and sends no request', async () => {
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={vi.fn()} />);

    await user.clear(screen.getByLabelText(/effective date/i));
    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByText(/effective date is required/i)).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('surfaces an API 400 and keeps the entered values', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={onSubmitted} />);

    await fillBankFields(user);

    fetchMock.mockImplementation((url) => {
      if (String(url).includes('/events')) {
        return Promise.resolve(
          jsonResponse(
            {
              statusCode: 400,
              message: ['iban: iban must be a valid IBAN (e.g. DE89 3704 0044 0532 0130 00)'],
              error: 'BadRequestException',
              timestamp: '2026-08-26T00:00:00.000Z',
              path: '/events',
            },
            400,
          ),
        );
      }
      return Promise.resolve(jsonResponse(employeesPage));
    });

    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/iban/);
    expect(screen.getByLabelText(/iban/i)).toHaveValue('DE89370400440532013000');
    expect(pickerTrigger()).toHaveTextContent(/emp-1/);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('sends a fresh Idempotency-Key per submit, displays the 201, and records it', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    const spy = vi.spyOn(crypto, 'randomUUID');
    render(<SubmitForm onSubmitted={onSubmitted} />);

    await fillBankFields(user);
    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByText(/created/i)).toBeInTheDocument();
    expect(screen.getByText(/evt-default/)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);

    // Second submit: re-fill the (back-to-defaults) form and submit again.
    await fillBankFields(user);
    await user.click(screen.getByRole('button', { name: /submit event/i }));
    await screen.findByText(/created/i);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(onSubmitted).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls
      .filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST')
      .map(([, i]) => ((i as RequestInit).headers as Record<string, string>))
      .map((headers) => headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2); // a fresh key per submit
  });

  it('re-prefills the picker and shows the watch-for hint when the demo scenario changes', async () => {
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={vi.fn()} />);

    expect(screen.getByText(/success attempt row at attempt 1/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('scenario-trigger'));
    await user.click(screen.getByTestId('scenario-option-retry-fail'));

    // The scenario's demo employee is a seeded directory row, so the picker
    // shows it after the re-prefill.
    expect(pickerTrigger()).toHaveTextContent(/EMP-DEMO-TRANSIENT/);
    expect(screen.getByText(/failed \/ temporary/i)).toBeInTheDocument();
  });

  it('submits with the selected scenario employee id', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={onSubmitted} />);

    await user.click(screen.getByTestId('scenario-trigger'));
    await user.click(screen.getByTestId('scenario-option-permanent'));

    await user.click(screen.getByRole('button', { name: /submit event/i }));
    await screen.findByText(/evt-default/);

    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeDefined();
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body.payload.employeeId).toBe('EMP-DEMO-PERMANENT');
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('preserves the selected scenario across a reset', async () => {
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={vi.fn()} />);

    await user.click(screen.getByTestId('scenario-trigger'));
    await user.click(screen.getByTestId('scenario-option-permanent'));

    await user.click(screen.getByRole('button', { name: /reset/i }));
    expect(pickerTrigger()).toHaveTextContent(/EMP-DEMO-PERMANENT/);
  });
});
