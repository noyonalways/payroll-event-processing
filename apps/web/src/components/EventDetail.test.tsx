import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchEventStatus, NetworkError } from '../api/events';
import type { EventAttempt, EventStatusResponse } from '../lib/types';
import type { TrackedEvent } from '../lib/storage';
import { EventDetail } from './EventDetail';

vi.mock('../api/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/events')>();
  return { ...actual, fetchEventStatus: vi.fn() };
});

function attempt(
  attemptNumber: number,
  status: 'SUCCESS' | 'FAILED',
  extra: Partial<EventAttempt> = {},
): EventAttempt {
  return {
    attemptNumber,
    status,
    errorType: null,
    failedReason: null,
    result: null,
    createdAt: `2026-08-26T00:00:0${attemptNumber}.000Z`,
    ...extra,
  };
}

function detail(
  id: string,
  overrides: Partial<EventStatusResponse> = {},
): EventStatusResponse {
  return {
    id,
    eventType: 'BANK_ACCOUNT_CHANGE',
    employeeId: 'emp-1',
    sequence: 1,
    status: 'queued',
    payload: {
      employeeId: 'emp-1',
      effectiveDate: '2026-09-01',
      iban: 'DE89370400440532013000',
    },
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    processedAt: null,
    result: null,
    attempts: [],
    ...overrides,
  };
}

function entry(overrides: Partial<TrackedEvent> = {}): TrackedEvent {
  return {
    id: 'e-detail',
    eventType: 'BANK_ACCOUNT_CHANGE',
    employeeId: 'emp-1',
    lastStatus: 'queued',
    attempts: 0,
    sequence: 1,
    submittedAt: '2026-08-26T00:00:00.000Z',
    idempotencyKey: 'key-detail',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchEventStatus).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventDetail', () => {
  it('shows the result and processedAt for a successful event', async () => {
    vi.mocked(fetchEventStatus).mockResolvedValue(
      detail('e-detail', {
        status: 'success',
        processedAt: '2026-08-26T00:00:09.000Z',
        result: { reference: 'SIM-external-payroll-op:req', affectedFields: { iban: 'DE89…' } },
        attempts: [
          attempt(1, 'SUCCESS', {
            createdAt: '2026-08-26T00:00:01.000Z',
            result: { reference: 'SIM-external-payroll-op:req' },
          }),
        ],
      }),
    );

    render(<EventDetail entry={entry({ lastStatus: 'success' })} />);

    expect(await screen.findByText('2026-08-26T00:00:09.000Z')).toBeInTheDocument();
    // The handler result renders on the section and on the attempt trail.
    expect(screen.getAllByText(/SIM-external-payroll-op:req/)).toHaveLength(2);
    // The badge renders for the section status and for the successful attempt.
    expect(screen.getAllByText('Success')).toHaveLength(2);
    expect(screen.getByText('Attempt 1')).toBeInTheDocument();
  });

  it('shows failedReason and errorType for a failed event', async () => {
    vi.mocked(fetchEventStatus).mockResolvedValue(
      detail('e-detail', {
        status: 'failed',
        processedAt: null,
        result: null,
        attempts: [
          attempt(1, 'FAILED', {
            errorType: 'PERMANENT',
            failedReason: 'Simulated provider rejected the change',
          }),
        ],
      }),
    );

    render(<EventDetail entry={entry({ lastStatus: 'failed' })} />);

    expect(await screen.findByText(/simulated provider rejected the change/i))
      .toBeInTheDocument();
    expect(screen.getByText('PERMANENT')).toBeInTheDocument();
    expect(screen.getByText(/Error type:/)).toBeInTheDocument();
    // The badge renders for the section status and for the failing attempt.
    expect(screen.getAllByText('Failed')).toHaveLength(2);
  });

  it('renders attempts ascending by attemptNumber regardless of response order', async () => {
    vi.mocked(fetchEventStatus).mockResolvedValue(
      detail('e-detail', {
        status: 'failed',
        attempts: [
          attempt(2, 'FAILED', { errorType: 'TEMPORARY', failedReason: 'retries exhausted' }),
          attempt(1, 'FAILED', { errorType: 'TEMPORARY', failedReason: 'transient hiccup' }),
        ],
      }),
    );

    render(<EventDetail entry={entry({ lastStatus: 'failed' })} />);

    const attempts = await screen.findAllByRole('listitem');
    expect(attempts[0]).toHaveTextContent('Attempt 1');
    expect(attempts[0]).toHaveTextContent('transient hiccup');
    expect(attempts[1]).toHaveTextContent('Attempt 2');
    expect(attempts[1]).toHaveTextContent('retries exhausted');
  });

  it('renders the unavailable state when the fetch fails', async () => {
    vi.mocked(fetchEventStatus).mockRejectedValue(
      new NetworkError(new TypeError('Failed to fetch')),
    );

    render(<EventDetail entry={entry()} />);

    expect(await screen.findByText(/currently unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });
});