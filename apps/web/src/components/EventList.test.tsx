import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedEvent } from '../lib/storage';
import { EventList } from './EventList';

function tracked(overrides: Partial<TrackedEvent> = {}): TrackedEvent {
  return {
    id: '12345678-1234-1234-1234-12345678abcd',
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-9',
    lastStatus: 'success',
    attempts: 2,
    sequence: 3,
    submittedAt: '2026-08-26T00:00:00.000Z',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

describe('EventList', () => {
  it('renders a row with id, type, employee, sequence, badge, and attempts', () => {
    render(<EventList entries={[tracked()]} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText('12345678…abcd')).toBeInTheDocument();
    expect(screen.getByText('SALARY_CHANGE')).toBeInTheDocument();
    expect(screen.getByText('emp-9')).toBeInTheDocument();
    expect(screen.getByText('seq 3')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('2 attempts')).toBeInTheDocument();
  });

  it('calls onSelect with the full id on row click', () => {
    const onSelect = vi.fn();
    render(<EventList entries={[tracked()]} selectedId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onSelect).toHaveBeenCalledWith('12345678-1234-1234-1234-12345678abcd');
  });

  it('marks the selected row as pressed', () => {
    const id = '12345678-1234-1234-1234-12345678abcd';
    render(<EventList entries={[tracked()]} selectedId={id} onSelect={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders an unavailable badge for a row whose last poll failed', () => {
    render(
      <EventList
        entries={[tracked({ error: 'Could not reach the payroll API' })]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Success')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing is tracked', () => {
    render(<EventList entries={[]} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText(/no events tracked yet/i)).toBeInTheDocument();
  });
});