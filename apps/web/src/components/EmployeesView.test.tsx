import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL } from '../api/client';
import { EmployeesView } from './EmployeesView';
import type { Employee } from '../lib/types';

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const row = (overrides: Partial<Employee> = {}): Employee => ({
  id: 'row-1',
  employeeNumber: 'emp-001',
  name: 'Ada Lovelace',
  department: 'Engineering',
  active: true,
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T09:00:00.000Z',
  ...overrides,
});

/** Default store: what GET /employees answers before any mutation. */
let directory: Employee[];

function defaultRoute(): Promise<Response> {
  return Promise.resolve(
    jsonResponse({ data: directory, nextCursor: null, limit: 50 }),
  );
}

describe('EmployeesView', () => {
  beforeEach(() => {
    directory = [
      row({ id: 'row-1', employeeNumber: 'EMP-DEMO-SUCCESS', name: 'Demo employee (success)' }),
      row({ id: 'row-2', employeeNumber: 'emp-005', name: 'Grace Hopper', department: 'Navy' }),
    ];
    fetchMock.mockImplementation(defaultRoute);
  });

  it('renders the server-fetched directory rows', async () => {
    render(<EmployeesView />);

    expect(await screen.findByText(/Grace Hopper/)).toBeInTheDocument();
    expect(screen.getByText('EMP-DEMO-SUCCESS')).toBeInTheDocument();
    expect(screen.getAllByTestId('employee-row-active')).toHaveLength(2);
  });

  it('registers an employee: the form clears and the new row comes from the server', async () => {
    const user = userEvent.setup();
    render(<EmployeesView />);
    await screen.findByText(/Grace Hopper/);

    // One POST (201) then the re-fetch page one now holding three rows — the
    // additional row is SERVER data, not a local append.
    await user.type(screen.getByTestId('employee-number-input'), 'emp-007');
    await user.type(screen.getByTestId('employee-name-input'), 'Alan Turing');
    fetchMock.mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(row({ id: 'row-3', employeeNumber: 'emp-007', name: 'Alan Turing' }), 201),
        );
      }
      // Return a fresh copy — the mock accumulates rows like the store would.
      const withNew =
        directory.some((r) => r.id === 'row-3')
          ? directory
          : directory.concat(
              row({ id: 'row-3', employeeNumber: 'emp-007', name: 'Alan Turing' }),
            );
      return Promise.resolve(jsonResponse({ data: withNew, nextCursor: null, limit: 50 }));
    });

    await user.click(screen.getByTestId('employee-create-submit'));

    expect(await screen.findByText('Alan Turing')).toBeInTheDocument();
    expect(await screen.findByText('emp-007')).toBeInTheDocument();
    // The form blanked for the next registration.
    expect(
      (screen.getByTestId('employee-number-input') as HTMLInputElement).value,
    ).toBe('');
    expect(
      (screen.getByTestId('employee-name-input') as HTMLInputElement).value,
    ).toBe('');
  });

  it('surfaces a duplicate-number 409 with the values kept editable', async () => {
    const user = userEvent.setup();
    render(<EmployeesView />);
    await screen.findByText(/Grace Hopper/);

    fetchMock.mockImplementation(defaultRoute as never); // GETs stay
    fetchMock.mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              statusCode: 409,
              message:
                'An employee with employeeNumber "emp-005" already exists in this organization',
              error: 'ConflictException',
              timestamp: '2026-10-16T09:00:00.000Z',
              path: '/employees',
            },
            409,
          ),
        );
      }
      return defaultRoute();
    });

    await user.type(screen.getByTestId('employee-number-input'), 'emp-005');
    await user.type(screen.getByTestId('employee-name-input'), 'Grace Again');
    await user.click(screen.getByTestId('employee-create-submit'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already exists in this organization/i);
    // Values preserved for correction.
    expect(
      (screen.getByTestId('employee-number-input') as HTMLInputElement).value,
    ).toBe('emp-005');
    expect(
      (screen.getByTestId('employee-name-input') as HTMLInputElement).value,
    ).toBe('Grace Again');
  });

  it('archives with confirmation and reflects the archived state fetched from the server', async () => {
    const user = userEvent.setup();
    render(<EmployeesView />);
    await screen.findByText(/Grace Hopper/);

    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === `${API_BASE_URL}/employees/row-2` && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        jsonResponse({
          data: directory.map((r) => (r.id === 'row-2' ? { ...r, active: false } : r)),
          nextCursor: null,
          limit: 50,
        }),
      );
    });

    await user.click(screen.getByTestId('employee-archive-row-2'));

    // The DELETE carried the session and the confirm was asked.
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/Archive/i));
    const deleteCall = fetchMock.mock.calls.find(
      ([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/row-2'),
    );
    expect(deleteCall).toBeDefined();

    // The row still exists — archived, not erased.
    const archivedRow = await screen.findByTestId('employee-row-emp-005');
    expect(archivedRow).toBeInTheDocument();
    expect(screen.getByTestId('employee-row-emp-005')).toHaveTextContent('archived');
  });

  it('shows an empty state instead of improvised rows when nothing matches', async () => {
    directory = [];
    render(<EmployeesView />);

    expect(await screen.findByTestId('employee-directory-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('employee-row-number')).toHaveLength(0);
  });

  it('waits on the server state during load', async () => {
    let resolvePage: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvePage = resolve;
        }),
    );
    render(<EmployeesView />);

    await waitFor(() => expect(screen.getByTestId('employee-directory-loading')).toBeInTheDocument());
    resolvePage?.(jsonResponse({ data: directory, nextCursor: null, limit: 50 }));
    expect(await screen.findByText(/Grace Hopper/)).toBeInTheDocument();
  });
});
