import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, type EventStatusNotification } from '@repo/shared';
import type { EventStreamHandle } from '../api/stream';
import { useEventStream } from './useEventStream';

// The hook consumes the SSE transport; replace it with a controllable fake
// that hands the CURRENT handlers to the test (latest-open wins).
const openMock = vi.fn();

vi.mock('../api/stream', () => ({
  openEventStream: (...args: unknown[]) => openMock(...args),
}));

const notification = (overrides: Partial<EventStatusNotification> = {}): EventStatusNotification => ({
  organizationId: 'org-1',
  eventId: 'evt-1',
  eventType: EventType.BANK_ACCOUNT_CHANGE,
  employeeId: 'emp-1',
  sequence: 1,
  status: 'queued',
  occurredAt: '2026-10-16T10:00:00.000Z',
  ...overrides,
});

type Handlers = {
  onOpen: () => void;
  onNotification: (n: EventStatusNotification) => void;
  onDisconnect: (reason: 'ended' | 'error', error?: unknown) => void;
};

let lastHandlers: Handlers | null = null;
let openCount = 0;
let closeSpies: Array<ReturnType<typeof vi.fn>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  openMock.mockReset();
  lastHandlers = null;
  openCount = 0;
  closeSpies = [];
  openMock.mockImplementation((handlers: Handlers): EventStreamHandle => {
    lastHandlers = handlers;
    openCount += 1;
    const close = vi.fn();
    closeSpies.push(close);
    return { close };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Actual tests never `waitFor` under fake timers — the state flips happen in
 * `act` around the fake's own callbacks, so assertions read synchronously.
 */
describe('useEventStream', () => {
  it('opens one connection while enabled and routes notifications through the latest callback', () => {
    const seen: EventStatusNotification[] = [];
    const { result, rerender } = renderHook(
      ({ onNotification }: { onNotification: (n: EventStatusNotification) => void }) =>
        useEventStream({ enabled: true, onNotification }),
      { initialProps: { onNotification: (n: EventStatusNotification) => void seen.push(n) } },
    );
    act(() => {
      lastHandlers!.onOpen();
    });
    expect(result.current.connected).toBe(true);
    expect(openCount).toBe(1);

    // A rerender swaps the callback identity WITHOUT reconnecting: the open
    // count stays at one, and the notification goes to the NEW callback.
    const seenRerendered: EventStatusNotification[] = [];
    rerender({ onNotification: (n) => void seenRerendered.push(n) });
    act(() => {
      lastHandlers!.onNotification(notification());
    });
    expect(seenRerendered).toHaveLength(1);
    expect(seen).toHaveLength(0);
    expect(openCount).toBe(1);
  });

  it('reschedules with backoff after each disconnect and marks the outage', () => {
    const { result } = renderHook(() =>
      useEventStream({ enabled: true, onNotification: () => {} }),
    );

    // First open → live; then the server ends the stream.
    act(() => {
      lastHandlers!.onOpen();
    });
    expect(result.current.connected).toBe(true);
    act(() => {
      lastHandlers!.onDisconnect('ended');
    });
    expect(result.current.connected).toBe(false);

    // The reconnect is scheduled, not immediate: with no time passing, the
    // open count is still 1 (first connection only).
    expect(openCount).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    // Second connection opened after the first backoff step.
    expect(openCount).toBe(2);

    // A second loss schedules the NEXT backoff step (2s, not 1s).
    act(() => {
      lastHandlers!.onDisconnect('error', new Error('ECONNRESET'));
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(openCount).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(openCount).toBe(3);
  });

  it('invokes onResync exactly once per gap: after reconnecting, never on first open', () => {
    const onResync = vi.fn();
    const { result } = renderHook(() =>
      useEventStream({ enabled: true, onNotification: () => {}, onResync }),
    );

    act(() => {
      lastHandlers!.onOpen();
    });
    expect(onResync).not.toHaveBeenCalled();

    // Drop and reconnect: the resync fires when the pipe is live again.
    act(() => {
      lastHandlers!.onDisconnect('ended');
    });
    expect(onResync).not.toHaveBeenCalled();
    act(() => {
      lastHandlers!.onOpen(); // the reconnect callback
    });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(result.current.connected).toBe(true);
  });

  it('does not reconnect after unmount (close was caller-requested and callbacks are dead)', () => {
    const { unmount } = renderHook(() =>
      useEventStream({ enabled: true, onNotification: () => {} }),
    );
    act(() => {
      lastHandlers!.onOpen();
    });

    unmount();
    expect(closeSpies[0]).toHaveBeenCalled();

    // Even a late server-side disconnect must not schedule a reconnect.
    act(() => {
      lastHandlers!.onDisconnect('ended');
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(openCount).toBe(1);
  });

  it('disabled tears the stream down and opens nothing while disabled', () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useEventStream({ enabled, onNotification: () => {} }),
      { initialProps: { enabled: true } },
    );
    expect(openCount).toBe(1);

    // The enable flip closed the first connection via the effect cleanup.
    rerender({ enabled: false });
    expect(closeSpies[0]).toHaveBeenCalled();

    rerender({ enabled: true });
    expect(openCount).toBe(2);
  });
});
