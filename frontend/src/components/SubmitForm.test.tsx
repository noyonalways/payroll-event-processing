import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordSubmissionInput } from '../lib/useEventTracker';
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

    expect(screen.getByLabelText(/employee id/i)).toHaveValue('EMP-001');
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
    expect(onSubmitted.mock.calls[0][0]).toMatchObject({
      eventType: 'BANK_ACCOUNT_CHANGE',
      employeeId: 'EMP-001',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      eventType: 'BANK_ACCOUNT_CHANGE',
      payload: {
        employeeId: 'EMP-001',
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
    expect(onSubmitted.mock.calls[0][0]).toMatchObject({
      id: 'evt-1',
      eventType: 'BANK_ACCOUNT_CHANGE',
      employeeId: 'emp-1',
    });

    // Second submit: re-fill the (back-to-defaults) form and submit again.
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'evt-2', status: 'received' }, 201),
    );
    await fillBankFields(user);
    await user.click(screen.getByRole('button', { name: /submit event/i }));
    await screen.findByText(/evt-2/);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(onSubmitted).toHaveBeenCalledTimes(2);
    const submissions = onSubmitted.mock.calls.map(
      ([submission]) => submission as RecordSubmissionInput,
    );
    expect(submissions[0].idempotencyKey).not.toBe(submissions[1].idempotencyKey);

    const keys = fetchMock.mock.calls.map(([, init]) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      return headers['Idempotency-Key'];
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(submissions[0].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });
});