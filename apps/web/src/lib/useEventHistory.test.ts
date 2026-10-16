import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, type EventStatusNotification } from '@repo/shared';

import { fetchEventStatus, fetchEventsPage, NetworkError } from '../api/events';
import type { EventListItem, EventListResponse, EventStatusResponse } from './types';
import { POLL_INTERVAL_MS, useEventHistory } from './useEventHistory';
import type { UseEventStreamOptions } from './useEventStream';

// The hook consumes the API layer; replace it with controllable spies.
vi.mock('../api/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/events')>();
  return {
    ...actual,
    fetchEventsPage: vi.fn(),
    fetchEventStatus: vi.fn(),
  };
});

// The stream subscription is replaced with a controllable fake: the test decides
// whether the stream reports `connected` (live updates) or not (polling
// fallback regime), and drives notifications through the captured handlers.
const streamState = {
  connected: false,
  options: null as UseEventStreamOptions | null,
};
vi.mock('./useEventStream', () => ({
  useEventStream: (options: UseEventStreamOptions) => {
    streamState.options = options;
    return { connected: streamState.connected };
  },
}));

function entry(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    eventType: 'BANK_ACCOUNT_CHANGE',
    employeeId: 'emp-1',
    sequence: 1,
    status: 'queued',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    processedAt: null,
    id,
    ...overrides,
  };
}

function page(
  data: EventListItem[],
  nextCursor: string | null = null,
): EventListResponse {
  return { data, nextCursor, limit: 20 };
}

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

const listMock = vi.mocked(fetchEventsPage);
const statusMock = vi.mocked(fetchEventStatus);

beforeEach(() => {
  localStorage.clear();
  listMock.mockReset();
  statusMock.mockReset();
  streamState.connected = false;
  streamState.options = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useEventHistory', () => {
  it('fetches page one on mount and persists nothing locally', async () => {
    listMock.mockResolvedValue(page([entry('e-1'), entry('e-2')]));
    const { result } = renderHook(() => useEventHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Page one arrives with no submission in this session — the server is the
    // only source of the history.
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0][0]).toEqual({ limit: 20 });
    expect(result.current.rows.map((r) => r.id)).toEqual(['e-1', 'e-2']);
    expect(result.current.loadError).toBeNull();
    // And no localStorage key was written: reloads simply re-fetch.
    expect(localStorage.length).toBe(0);
  });

  it('exposes a load error as state with no rows when the page fetch fails', async () => {
    listMock.mockRejectedValue(new NetworkError(new TypeError('Failed to fetch')));
    const { result } = renderHook(() => useEventHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.rows).toEqual([]);
    expect(result.current.loadError).toContain('Could not reach');
    expect(result.current.hasMore).toBe(false);
  });

  it('appends the next page on load-more by following nextCursor', async () => {
    listMock.mockResolvedValueOnce(page([entry('e-1'), entry('e-2')], 'cursor-1'));
    const { result } = renderHook(() => useEventHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    listMock.mockResolvedValueOnce(page([entry('e-3'), entry('e-4')]));
    await act(async () => {
      await result.current.loadMore();
    });

    // The walk continues from the stored cursor, at the same page size.
    expect(listMock).toHaveBeenLastCalledWith({ limit: 20, cursor: 'cursor-1' });
    expect(result.current.rows.map((r) => r.id)).toEqual([
      'e-1',
      'e-2',
      'e-3',
      'e-4',
    ]);
    // Last page: nextCursor null, the walk terminates.
    expect(result.current.hasMore).toBe(false);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches page one with the new filter when a filter changes', async () => {
    listMock.mockResolvedValueOnce(page([entry('e-1'), entry('e-2')], 'cursor-1'));
    const { result } = renderHook(() => useEventHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    listMock.mockResolvedValueOnce(page([entry('e-failed')]));
    act(() => {
      result.current.setFilter('status', 'failed');
    });
    await waitFor(() =>
      expect(result.current.rows.map((r) => r.id)).toEqual(['e-failed']),
    );

    // A fresh page one for the new selection — never a client-side narrow of
    // the pages already on screen.
    expect(listMock).toHaveBeenLastCalledWith({ limit: 20, status: 'failed' });
  });

  it('combines an active filter with the cursor when paging a filtered selection', async () => {
    listMock.mockResolvedValueOnce(page([entry('e-0')], 'c0'));
    const { result } = renderHook(() => useEventHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Two filters stack, each a re-fetch of page one.
    listMock.mockResolvedValueOnce(page([entry('e-1')], 'c1'));
    act(() => {
      result.current.setFilter('eventType', 'SALARY_CHANGE');
    });
    await waitFor(() =>
      expect(result.current.rows.map((r) => r.id)).toEqual(['e-1']),
    );
    listMock.mockResolvedValueOnce(page([entry('e-2')], 'c2'));
    act(() => {
      result.current.setFilter('status', 'failed');
    });
    await waitFor(() =>
      expect(result.current.rows.map((r) => r.id)).toEqual(['e-2']),
    );
    expect(listMock).toHaveBeenLastCalledWith({
      status: 'failed',
      eventType: 'SALARY_CHANGE',
      limit: 20,
    });

    // …and load-more continues THAT filtered selection with a cursor.
    listMock.mockResolvedValueOnce(page([entry('e-3')], null));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(listMock).toHaveBeenLastCalledWith({
      status: 'failed',
      eventType: 'SALARY_CHANGE',
      limit: 20,
      cursor: 'c2',
    });
    expect(result.current.rows.map((r) => r.id)).toEqual(['e-2', 'e-3']);
    expect(result.current.hasMore).toBe(false);
  });

  it('sends the employee filter and covers a date-only upper bound through its day', async () => {
    listMock.mockResolvedValue(page([]));
    const { result } = renderHook(() => useEventHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFilter('employeeId', 'emp-7');
      result.current.setFilter('createdAfter', '2026-08-01');
      result.current.setFilter('createdBefore', '2026-08-31');
    });
    listMock.mockResolvedValue(page([]));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ employeeId: 'emp-7' }),
    ));

    const sent = listMock.mock.calls.at(-1)?.[0];
    expect(sent?.createdAfter).toBe('2026-08-01'); // inclusive start of day
    expect(sent?.createdBefore).toBe('2026-08-31T23:59:59.999Z');
  });

  it('clearing filters re-fetches the unfiltered page one', async () => {
    listMock.mockResolvedValue(page([entry('e-1')]));
    const { result } = renderHook(() => useEventHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFilter('status', 'failed');
    });
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed' }),
    ));

    act(() => {
      result.current.clearFilters();
    });
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ limit: 20 }));
  });
});

describe('useEventHistory row polling', () => {
  // These tests run in the POLLING-FALLBACK regime: the stream fake reports
  // disconnected, which is exactly the degraded mode the live updates degrade
  // to (former fixed-cadence semantics, per-row error isolation).
  it('polls non-terminal rows, hydrates attempts, and stops once terminal is observed', async () => {
    vi.useFakeTimers();
    listMock.mockResolvedValue(page([entry('e-1'), entry('e-2', { status: 'failed' })]));
    const { result } = renderHook(() => useEventHistory());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);

    // First cadence: e-1 (queued) polls forever-capable rows; e-2 was listed
    // terminal and never polled, so it owes its one hydration poll too.
    statusMock.mockImplementation((id: string) =>
      id === 'e-1'
        ? Promise.resolve(
            statusResponse({
              id,
              status: 'success',
              attempts: [
                {
                  attemptNumber: 1,
                  status: 'SUCCESS',
                  errorType: null,
                  failedReason: null,
                  result: null,
                  createdAt: '2026-08-26T00:00:01.000Z',
                },
              ],
            }),
          )
        : Promise.resolve(statusResponse({ id, status: 'failed' })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(result.current.rows.find((r) => r.id === 'e-1')?.status).toBe('success');
    expect(result.current.rows.find((r) => r.id === 'e-1')?.attempts).toBe(1);
    expect(result.current.rows.find((r) => r.id === 'e-2')?.attempts).toBe(0);

    // Later cadences: both rows are terminal AND hydrated — no further polls.
    statusMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('marks a failing row unavailable while the rest keeps polling and retries it', async () => {
    vi.useFakeTimers();
    listMock.mockResolvedValue(page([entry('e-fail'), entry('e-ok')]));
    const { result } = renderHook(() => useEventHistory());
    await act(async () => {
      await Promise.resolve();
    });

    statusMock.mockImplementation((id: string) =>
      id === 'e-fail'
        ? Promise.reject(new NetworkError(new TypeError('Failed to fetch')))
        : Promise.resolve(statusResponse({ id, status: 'queued' })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    // Each row fails or succeeds independently.
    expect(result.current.rows.find((r) => r.id === 'e-fail')?.error).toBeTruthy();
    expect(result.current.rows.find((r) => r.id === 'e-ok')?.error).toBeUndefined();

    // The failed row is retried on later ticks (and self-heals once answered).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    const failCalls = statusMock.mock.calls.filter(([id]) => id === 'e-fail');
    expect(failCalls.length).toBe(2);

    statusMock.mockImplementation((id: string) =>
      Promise.resolve(statusResponse({ id, status: 'success' })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.rows.find((r) => r.id === 'e-fail')?.error).toBeUndefined();
  });
});

describe('useEventHistory over the event stream (live regime)', () => {
  const notification = (
    overrides: Partial<EventStatusNotification> = {},
  ): EventStatusNotification => ({
    organizationId: 'org-1',
    eventId: 'e-1',
    eventType: EventType.BANK_ACCOUNT_CHANGE,
    employeeId: 'emp-1',
    sequence: 1,
    status: 'success',
    occurredAt: '2026-10-16T10:00:00.000Z',
    ...overrides,
  });

  const renderLive = async () => {
    listMock.mockResolvedValue(page([entry('e-1')]));
    const rendered = renderHook(() => useEventHistory());
    // No `waitFor` under fake timers: one microtask flush settles the page.
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.result.current.loading).toBe(false);
    // The stream reports healthy AFTER the list is on screen.
    streamState.connected = true;
    await act(async () => {
      rendered.rerender();
    });
    return rendered;
  };

  it('updates a row badge in place from a notification with no fixed-cadence polling', async () => {
    vi.useFakeTimers();
    const { result } = await renderLive();

    // A non-terminal update exercises the pure-badge path (no hydration fetch).
    act(() => {
      streamState.options!.onNotification!(notification({ status: 'processing' }));
    });
    expect(result.current.rows.find((r) => r.id === 'e-1')?.status).toBe('processing');

    // While the stream is healthy there is NO fixed-cadence polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('hydrates a terminal row exactly once (attempt count) and ignores repeats', async () => {
    vi.useFakeTimers();
    const { result } = await renderLive();
    statusMock.mockResolvedValue(
      statusResponse({
        id: 'e-1',
        status: 'success',
        attempts: [
          {
            attemptNumber: 1,
            status: 'SUCCESS',
            errorType: null,
            failedReason: null,
            result: null,
            createdAt: '2026-10-16T10:00:01.000Z',
          },
        ],
      }),
    );

    act(() => {
      streamState.options!.onNotification!(notification({ status: 'success' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.rows.find((r) => r.id === 'e-1')?.attempts).toBe(1);
    expect(statusMock).toHaveBeenCalledTimes(1);

    // A repeat of the SAME terminal notification re-fetches nothing.
    act(() => {
      streamState.options!.onNotification!(notification({ status: 'success' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it('a notification for an unlisted event adds no row', async () => {
    const { result } = await renderLive();

    act(() => {
      streamState.options!.onNotification!(
        notification({ eventId: 'evt-elsewhere', status: 'success' }),
      );
    });

    expect(result.current.rows.map((r) => r.id)).toEqual(['e-1']);
  });

  it('re-synchronizes page one when the stream reconnects (onResync)', async () => {
    const { result } = await renderLive();
    const callsBefore = listMock.mock.calls.length;

    // The gap is closed by a fresh page-one fetch for the CURRENT filters.
    await act(async () => {
      streamState.options!.onResync?.();
    });
    expect(listMock.mock.calls.length).toBe(callsBefore + 1);
    expect(listMock).toHaveBeenLastCalledWith({ limit: 20 });
    expect(result.current.rows.map((r) => r.id)).toEqual(['e-1']);
  });
});
