import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchEventStatus, NetworkError } from '../api/events';
import type { EventStatusResponse } from './types';
import { TRACKED_EVENTS_STORAGE_KEY } from './storage';
import type { TrackedEvent } from './storage';
import { POLL_INTERVAL_MS, useEventTracker } from './useEventTracker';

// The polling loop consumes fetchEventStatus; replace it with a controllable spy.
vi.mock('../api/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/events')>();
  return { ...actual, fetchEventStatus: vi.fn() };
});

function statusResponse(
  overrides: Partial<EventStatusResponse> & { id: string },
): EventStatusResponse {
  return {
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

function tracked(
  id: string,
  overrides: Partial<TrackedEvent> = {},
): TrackedEvent {
  return {
    id,
    eventType: 'BANK_ACCOUNT_CHANGE',
    employeeId: 'emp-1',
    lastStatus: 'queued',
    attempts: 0,
    sequence: 1,
    submittedAt: '2026-08-26T00:00:00.000Z',
    idempotencyKey: `key-${id}`,
    ...overrides,
  };
}

function idsOf(entries: TrackedEvent[]): string[] {
  return entries.map((entry) => entry.id).sort();
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(fetchEventStatus).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useEventTracker', () => {
  it('restores entries from localStorage on mount', () => {
    localStorage.setItem(
      TRACKED_EVENTS_STORAGE_KEY,
      JSON.stringify([tracked('e-1'), tracked('e-2', { lastStatus: 'success' })]),
    );

    const { result } = renderHook(() => useEventTracker());

    expect(idsOf(result.current.entries)).toEqual(['e-1', 'e-2']);
    expect(result.current.entries.find((e) => e.id === 'e-2')?.lastStatus).toBe(
      'success',
    );
  });

  it('tolerates corrupt storage without crashing', () => {
    localStorage.setItem(TRACKED_EVENTS_STORAGE_KEY, 'not json {');

    const { result } = renderHook(() => useEventTracker());

    expect(result.current.entries).toEqual([]);
  });

  it('records a submission with its idempotency key and persists it', () => {
    const { result } = renderHook(() => useEventTracker());

    act(() => {
      result.current.recordSubmission({
        id: 'e-new',
        eventType: 'SALARY_CHANGE',
        employeeId: 'emp-9',
        idempotencyKey: 'k-99',
        submittedAt: '2026-08-26T00:00:00.000Z',
      });
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      id: 'e-new',
      eventType: 'SALARY_CHANGE',
      employeeId: 'emp-9',
      lastStatus: 'received',
      attempts: 0,
      idempotencyKey: 'k-99',
    });

    const stored = JSON.parse(
      localStorage.getItem(TRACKED_EVENTS_STORAGE_KEY) ?? '[]',
    ) as TrackedEvent[];
    expect(stored[0].idempotencyKey).toBe('k-99');
  });

  it('clears the list and storage', () => {
    localStorage.setItem(
      TRACKED_EVENTS_STORAGE_KEY,
      JSON.stringify([tracked('e-1')]),
    );

    const { result } = renderHook(() => useEventTracker());
    act(() => result.current.clearList());

    expect(result.current.entries).toEqual([]);
    expect(localStorage.getItem(TRACKED_EVENTS_STORAGE_KEY)).toBeNull();
  });

  it('polls until a terminal state and then stops', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEventTracker());
    act(() => {
      result.current.recordSubmission({
        id: 'e-1',
        eventType: 'BANK_ACCOUNT_CHANGE',
        employeeId: 'emp-1',
        idempotencyKey: 'key-1',
      });
    });

    const mock = vi.mocked(fetchEventStatus);
    mock.mockResolvedValue(
      statusResponse({
        id: 'e-1',
        status: 'success',
        processedAt: '2026-08-26T00:00:01.000Z',
        result: { reference: 'SIM-external-payroll-op:req' },
        attempts: [
          {
            attemptNumber: 1,
            status: 'SUCCESS',
            errorType: null,
            failedReason: null,
            result: { reference: 'SIM-external-payroll-op:req' },
            createdAt: '2026-08-26T00:00:01.000Z',
          },
        ],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.current.entries[0].lastStatus).toBe('success');
    expect(result.current.entries[0].attempts).toBe(1);

    // Two more intervals: no further polls for the terminal row.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('marks a failing row unavailable while the rest keeps polling', async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      TRACKED_EVENTS_STORAGE_KEY,
      JSON.stringify([tracked('e-fail'), tracked('e-ok')]),
    );

    const { result } = renderHook(() => useEventTracker());

    const mock = vi.mocked(fetchEventStatus);
    mock.mockImplementation((id: string) =>
      id === 'e-fail'
        ? Promise.reject(new NetworkError(new TypeError('Failed to fetch')))
        : Promise.resolve(statusResponse({ id, status: 'queued' })),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(result.current.entries.find((e) => e.id === 'e-fail')?.error).toBeTruthy();
    expect(result.current.entries.find((e) => e.id === 'e-ok')?.error).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    const okCalls = mock.mock.calls.filter(([id]) => id === 'e-ok');
    expect(okCalls.length).toBe(2);
  });
});