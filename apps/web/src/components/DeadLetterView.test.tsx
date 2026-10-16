import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeadLetterView } from './DeadLetterView';
import type { EventStatusResponse } from '../lib/types';

// The view consumes the API layer through the history/recovery hooks;
// replace it with controllable spies (hoisted so the vi.mock factory sees them).
const mocks = vi.hoisted(() => ({
  fetchEventsPage: vi.fn(),
  fetchEventStatus: vi.fn(),
  retryEvent: vi.fn(),
  cancelEvent: vi.fn(),
}));

vi.mock('../api/events', () => ({
  fetchEventsPage: mocks.fetchEventsPage,
  fetchEventStatus: mocks.fetchEventStatus,
  retryEvent: mocks.retryEvent,
  cancelEvent: mocks.cancelEvent,
}));

function listItem(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-fail',
    sequence: 1,
    status: 'failed',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:01.000Z',
    processedAt: null,
    ...overrides,
  };
}

function statusBody(id: string, status: string): EventStatusResponse {
  return {
    id,
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-fail',
    sequence: 1,
    status: status as EventStatusResponse['status'],
    payload: {
      employeeId: 'emp-fail',
      effectiveDate: '2026-10-01',
      newSalary: 1,
      currency: 'EUR',
    },
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:01.000Z',
    processedAt: null,
    result: null,
    attempts: [],
  } as EventStatusResponse;
}

const pageOf = (ids: string[]) => ({
  data: ids.map((id) => listItem(id)),
  nextCursor: null,
  limit: 20,
});

const confirmMock = vi.spyOn(window, 'confirm');

beforeEach(() => {
  mocks.fetchEventsPage.mockReset().mockResolvedValue(pageOf(['dead-1', 'dead-2']));
  mocks.fetchEventStatus.mockReset().mockResolvedValue(statusBody('dead-1', 'failed'));
  mocks.retryEvent.mockReset().mockResolvedValue({
    id: 'dead-1',
    status: 'queued',
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-fail',
  });
  mocks.cancelEvent.mockReset();
  confirmMock.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DeadLetterView', () => {
  it('lists the organization’s failed events from the failed-only page', async () => {
    render(<DeadLetterView />);

    // The lock: every fetch carries status=failed (an events-query filter).
    await waitFor(() => {
      expect(mocks.fetchEventsPage).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', limit: 20 }),
      );
    });
    // Both rows render with identity + attempt badge + retry action.
    expect((await screen.findAllByText('emp-fail')).length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByTestId('retry-dead-1')).toBeInTheDocument();
    expect(await screen.findByTestId('retry-dead-2')).toBeInTheDocument();
  });

  it('shows an explicit nothing-to-recover state for an empty organization', async () => {
    mocks.fetchEventsPage.mockResolvedValue(pageOf([]));

    render(<DeadLetterView />);

    expect(await screen.findByTestId('dead-letter-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('row-actions')).not.toBeInTheDocument();
  });

  it('retry re-queues the row and the re-fetched failed-only page loses the entry', async () => {
    // The page contents follow the server's committed state: while the row is
    // failed it appears; after the retry applies (lost the failed status) a
    // fresh fetch of the failed-only selection returns nothing. The retry
    // promise is held so the "server state change" lands BEFORE onSettled's
    // refresh reads the page — the exact order the real flow guarantees.
    let failedIds = ['dead-1'];
    mocks.fetchEventsPage.mockImplementation(async () => pageOf(failedIds));
    mocks.fetchEventStatus.mockResolvedValue(statusBody('dead-1', 'failed'));
    let releaseRetry: (() => void) | null = null;
    mocks.retryEvent.mockReturnValue(
      new Promise((resolve) => {
        releaseRetry = () =>
          resolve({
            id: 'dead-1',
            status: 'queued',
            eventType: 'SALARY_CHANGE',
            employeeId: 'emp-fail',
          } as never);
      }),
    );

    render(<DeadLetterView />);
    fireEvent.click(await screen.findByTestId('retry-dead-1'));
    await waitFor(() => expect(mocks.retryEvent).toHaveBeenCalledWith('dead-1'));

    failedIds = [];
    await act(async () => {
      releaseRetry?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('dead-letter-empty')).toBeInTheDocument();
    });
  });

  it('surfaces a 409 guard rejection without unmounting the view', async () => {
    mocks.fetchEventsPage.mockResolvedValue(pageOf(['dead-1']));
    mocks.fetchEventStatus.mockResolvedValue(statusBody('dead-1', 'cancelled'));
    mocks.retryEvent.mockRejectedValue({
      statusCode: 409,
      message: 'Event dead-1 is cancelled — only failed events can be retried',
    });

    render(<DeadLetterView />);
    fireEvent.click(await screen.findByTestId('retry-dead-1'));

    const alert = await screen.findByTestId('dead-letter-action-error');
    await waitFor(() => {
      expect(alert).toHaveTextContent(
        'Event dead-1 is cancelled — only failed events can be retried',
      );
    });
    // The row is still on screen (the view recovered, not collapsed).
    await waitFor(() => {
      expect(screen.getAllByText('emp-fail').length).toBeGreaterThanOrEqual(1);
    });
  });
});
