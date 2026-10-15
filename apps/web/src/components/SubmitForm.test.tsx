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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The form pre-fills sample values, so filling "smears" onto the defaults —
 * clear each field first, then type the fixture value.
 */
async function fillBankFields(user: ReturnType<typeof userEvent.setup>) {
  const employeeInput = screen.getByLabelText(/employee id/i);
  await user.clear(employeeInput);
  await user.type(employeeInput, 'emp-1');

  fireEvent.change(screen.getByLabelText(/effective date/i), {
    target: { value: '2026-09-01' },
  });

  const ibanInput = screen.getByLabelText(/iban/i);
  await user.clear(ibanInput);
  await user.type(ibanInput, 'DE89370400440532013000');
}

describe('SubmitForm', () => {
  it('renders the BANK_ACCOUNT_CHANGE fields by default', () => {
    render(<SubmitForm onSubmitted={vi.fn()} />);

    expect(screen.getByLabelText(/employee id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/effective date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/iban/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/new salary/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/street/i)).not.toBeInTheDocument();
  });

  it('pre-fills every field with sample values that pass the API', () => {
    render(<SubmitForm onSubmitted={vi.fn()} />);

    expect(screen.getByLabelText(/employee id/i)).toHaveValue('EMP-DEMO-SUCCESS');
    expect(screen.getByLabelText(/effective date/i)).toHaveValue('2026-09-01');
    expect(screen.getByLabelText(/iban/i)).toHaveValue(
      'DE89370400440532013000',
    );
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
    // The selected demo scenario is preserved across the event-type switch.
    expect(screen.getByLabelText(/employee id/i)).toHaveValue('EMP-DEMO-SUCCESS');
  });

  it('submits immediately with the pre-filled defaults (no typing)', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={onSubmitted} />);

    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'evt-default', status: 'received' }, 201),
    );
    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByText(/evt-default/)).toBeInTheDocument();
    expect(onSubmitted).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
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

    await user.clear(screen.getByLabelText(/employee id/i));
    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByText(/employee id is required/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces an API 400 and keeps the entered values', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={onSubmitted} />);

    await fillBankFields(user);

    fetchMock.mockResolvedValue(
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

    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/iban/);
    expect(screen.getByLabelText(/iban/i)).toHaveValue('DE89370400440532013000');
    expect(screen.getByLabelText(/employee id/i)).toHaveValue('emp-1');
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('sends a fresh Idempotency-Key per submit, displays the 201, and records it', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    const spy = vi.spyOn(crypto, 'randomUUID');
    render(<SubmitForm onSubmitted={onSubmitted} />);

    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'evt-1', status: 'received' }, 201),
    );
    await fillBankFields(user);
    await user.click(screen.getByRole('button', { name: /submit event/i }));

    expect(await screen.findByText(/created/i)).toBeInTheDocument();
    expect(screen.getByText(/evt-1/)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);

    // Second submit: re-fill the (back-to-defaults) form and submit again.
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'evt-2', status: 'received' }, 201),
    );
    await fillBankFields(user);
    await user.click(screen.getByRole('button', { name: /submit event/i }));
    await screen.findByText(/evt-2/);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(onSubmitted).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map(([, init]) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      return headers['Idempotency-Key'];
    });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2); // a fresh key per submit
  });

  it('re-prefills the employee id and shows the watch-for hint when the demo scenario changes', async () => {
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={vi.fn()} />);

    expect(screen.getByText(/success attempt row at attempt 1/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('scenario-trigger'));
    await user.click(screen.getByTestId('scenario-option-retry-fail'));

    expect(screen.getByLabelText(/employee id/i)).toHaveValue('EMP-DEMO-TRANSIENT');
    expect(screen.getByText(/failed \/ temporary/i)).toBeInTheDocument();
  });

  it('submits with the selected scenario employee id', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={onSubmitted} />);

    await user.click(screen.getByTestId('scenario-trigger'));
    await user.click(screen.getByTestId('scenario-option-permanent'));

    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'evt-perm', status: 'received' }, 201),
    );
    await user.click(screen.getByRole('button', { name: /submit event/i }));
    await screen.findByText(/evt-perm/);

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.payload.employeeId).toBe('EMP-DEMO-PERMANENT');
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('preserves the selected scenario across a reset', async () => {
    const user = userEvent.setup();
    render(<SubmitForm onSubmitted={vi.fn()} />);

    await user.click(screen.getByTestId('scenario-trigger'));
    await user.click(screen.getByTestId('scenario-option-permanent'));
    await user.clear(screen.getByLabelText(/employee id/i));

    await user.click(screen.getByRole('button', { name: /reset/i }));
    expect(screen.getByLabelText(/employee id/i)).toHaveValue('EMP-DEMO-PERMANENT');
  });
});