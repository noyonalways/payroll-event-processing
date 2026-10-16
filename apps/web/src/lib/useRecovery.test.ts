import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { cancelEvent, retryEvent } from '../api/events';
import { useRecovery } from './useRecovery';

// The hook consumes the API layer; replace it with controllable spies.
vi.mock('../api/events', () => ({
  retryEvent: vi.fn(),
  cancelEvent: vi.fn(),
}));

const confirmMock = vi.spyOn(window, 'confirm');

beforeEach(() => {
  vi.mocked(retryEvent).mockReset();
  vi.mocked(retryEvent).mockResolvedValue({
    id: 'e-1',
    status: 'queued',
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-1',
  });
  vi.mocked(cancelEvent).mockReset();
  vi.mocked(cancelEvent).mockResolvedValue({
    id: 'e-1',
    status: 'cancelled',
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-1',
  });
  confirmMock.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

const conflict = (message: string) =>
  new ApiError(409, {
    statusCode: 409,
    message,
    error: 'ConflictException',
    timestamp: '2026-10-16T00:00:00.000Z',
    path: '/events/e-1/retry',
  });

describe('useRecovery', () => {
  it('confirms, retries, and re-syncs the list through onSettled', async () => {
    const onSettled = vi.fn();
    const { result } = renderHook(() => useRecovery({ onSettled }));

    let applied = false;
    await act(async () => {
      applied = await result.current.retry('e-1');
    });

    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('Retry event e-1'),
    );
    expect(retryEvent).toHaveBeenCalledWith('e-1');
    expect(applied).toBe(true);
    expect(onSettled).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.pendingAction).toBeNull();
  });

  it('cancel asks a distinct question and calls the cancel endpoint', async () => {
    const { result } = renderHook(() => useRecovery({ onSettled: vi.fn() }));

    await act(async () => {
      await result.current.cancel('e-3');
    });

    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('Cancel event e-3'),
    );
    expect(cancelEvent).toHaveBeenCalledWith('e-3');
    expect(retryEvent).not.toHaveBeenCalled();
  });

  it('a declined confirmation sends no request', async () => {
    confirmMock.mockReturnValueOnce(false);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useRecovery({ onSettled }));

    let applied = true;
    await act(async () => {
      applied = await result.current.cancel('e-3');
    });

    expect(applied).toBe(false);
    expect(cancelEvent).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('surfaces a 409 guard rejection and STILL re-syncs the row', async () => {
    vi.mocked(retryEvent).mockRejectedValue(
      conflict('Event e-1 is queued — only failed events can be retried'),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useRecovery({ onSettled }));

    let applied = true;
    await act(async () => {
      applied = await result.current.retry('e-1');
    });

    expect(applied).toBe(false);
    expect(result.current.error).toMatchObject({
      action: 'retry',
      eventId: 'e-1',
      statusCode: 409,
      message: 'Event e-1 is queued — only failed events can be retried',
    });
    // The 409-aware re-fetch (the row raced the action) still happened.
    expect(onSettled).toHaveBeenCalled();
  });

  it('clearError drops the surfaced rejection', async () => {
    vi.mocked(retryEvent).mockRejectedValue(conflict('not failed'));
    const { result } = renderHook(() => useRecovery({ onSettled: vi.fn() }));
    await act(async () => {
      await result.current.retry('e-1');
    });
    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it('ignores a double invocation while a request is in flight', async () => {
    let resolveRetry: (() => void) | null = null;
    vi.mocked(retryEvent).mockReturnValue(
      new Promise((resolve) => {
        resolveRetry = () =>
          resolve({
            id: 'e-1',
            status: 'queued',
            eventType: 'SALARY_CHANGE',
            employeeId: 'emp-1',
          } as never);
      }),
    );
    const { result } = renderHook(() => useRecovery({ onSettled: vi.fn() }));

    let first: Promise<boolean> = Promise.resolve(true);
    act(() => {
      first = result.current.retry('e-1');
    });
    expect(result.current.pendingAction).toMatchObject({
      action: 'retry',
      eventId: 'e-1',
    });

    await act(async () => {
      const second = await result.current.retry('e-1');
      expect(second).toBe(false);
    });
    expect(retryEvent).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRetry?.();
      await first;
    });
    expect(result.current.pendingAction).toBeNull();
  });
});
