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
