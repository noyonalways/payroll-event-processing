import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { HistoryRow } from '../lib/useEventHistory';
import { EventList } from './EventList';

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: '12345678-1234-1234-1234-12345678abcd',
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-9',
    sequence: 3,
    status: 'success',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    processedAt: '2026-08-26T00:00:01.000Z',
    attempts: 2,
    ...overrides,
  };
}

describe('EventList', () => {
  it('renders a row with id, type, employee, sequence, badge, and attempts', () => {
    render(<EventList rows={[row()]} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText('12345678…abcd')).toBeInTheDocument();
    expect(screen.getByText('SALARY_CHANGE')).toBeInTheDocument();
    expect(screen.getByText('emp-9')).toBeInTheDocument();
    expect(screen.getByText('seq 3')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('2 attempts')).toBeInTheDocument();
  });

  it('calls onSelect with the full id on row click', () => {
    const onSelect = vi.fn();
    render(<EventList rows={[row()]} selectedId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onSelect).toHaveBeenCalledWith('12345678-1234-1234-1234-12345678abcd');
  });

  it('marks the selected row as pressed', () => {
    const id = '12345678-1234-1234-1234-12345678abcd';
    render(<EventList rows={[row()]} selectedId={id} onSelect={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders an unavailable badge for a row whose last poll failed', () => {
    render(
      <EventList
        rows={[row({ error: 'Could not reach the payroll API' })]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Success')).not.toBeInTheDocument();
  });

  it('renders the lifecycle badge a queued row polls toward', () => {
    render(
      <EventList
        rows={[row({ status: 'queued' })]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('shows an empty state when the history has no rows', () => {
    render(<EventList rows={[]} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText(/no events match/i)).toBeInTheDocument();
  });
});

describe('EventList recovery actions (event-recovery)', () => {
  const id = '12345678-1234-1234-1234-12345678abcd';

  it('offers retry ONLY on failed rows and cancel ONLY on pending rows', () => {
    render(
      <EventList
        rows={[
          row({ id, status: 'failed', processedAt: null }),
          row({ id: 'row-queued', employeeId: 'emp-2', status: 'queued' }),
          row({ id: 'row-success', employeeId: 'emp-3', status: 'success' }),
          row({ id: 'row-cancelled', employeeId: 'emp-4', status: 'cancelled' }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId(`retry-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId('cancel-row-queued')).toBeInTheDocument();
    // Terminal rows carry no actions at all.
    expect(screen.queryByTestId('retry-row-success')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cancel-row-success')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retry-row-cancelled')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cancel-row-cancelled')).not.toBeInTheDocument();
  });

  it('offers no actions at all when the callbacks are absent (read-only list)', () => {
    render(<EventList rows={[row({ id, status: 'failed' })]} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.queryByTestId('row-actions')).not.toBeInTheDocument();
  });

  it('invokes onRetry/onCancel with the full id, without selecting the row', () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    render(
      <EventList
        rows={[
          row({ id, status: 'failed', processedAt: null }),
          row({ id: 'row-queued', employeeId: 'emp-2', status: 'queued' }),
        ]}
        selectedId={null}
        onSelect={onSelect}
        onRetry={onRetry}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId(`retry-${id}`));
    fireEvent.click(screen.getByTestId('cancel-row-queued'));

    expect(onRetry).toHaveBeenCalledWith(id);
    expect(onCancel).toHaveBeenCalledWith('row-queued');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('disables the acting row’s buttons while its action is in flight', () => {
    render(
      <EventList
        rows={[
          row({ id, status: 'failed', processedAt: null }),
          row({ id: 'row-failed-2', employeeId: 'emp-2', status: 'failed', processedAt: null }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        pendingAction={{ action: 'retry', eventId: id }}
      />,
    );

    expect(screen.getByTestId(`retry-${id}`)).toBeDisabled();
    // Only the acting row is disabled.
    expect(screen.getByTestId('retry-row-failed-2')).toBeEnabled();
  });

  it('offers no action on a row whose poll failed (unavailable)', () => {
    render(
      <EventList
        rows={[row({ id, status: 'failed', error: 'poll dropped' })]}
        selectedId={null}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('row-actions')).not.toBeInTheDocument();
  });
});
