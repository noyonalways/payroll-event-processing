import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL, ApiError } from './client';
import {
  archiveEmployee,
  createEmployee,
  fetchEmployeesPage,
  updateEmployee,
} from './employees';
import type { Employee } from '../lib/types';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const employee = (overrides: Partial<Employee> = {}): Employee => ({
  id: 'row-1',
  employeeNumber: 'emp-001',
  name: 'Ada Lovelace',
  department: 'Engineering',
  active: true,
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T09:00:00.000Z',
  ...overrides,
});

describe('fetchEmployeesPage', () => {
  it('GETs /employees with only the set filters (the DTO deny-by-default surface)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], nextCursor: null, limit: 50 }));

    await fetchEmployeesPage({ active: true, search: 'ada' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/employees?active=true&search=ada`);
    // The directory read carries the session but no Idempotency-Key.
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('omits unset filters and follows a cursor', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], nextCursor: null, limit: 50 }));

    await fetchEmployeesPage({ cursor: 'next-page-token' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/employees?cursor=next-page-token`);
  });

  it('raises ApiError for a structured failure (bad cursor 400)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          statusCode: 400,
          message: 'cursor is not a valid employee-list cursor',
          error: 'BadRequestException',
          timestamp: '2026-10-16T09:00:00.000Z',
          path: '/employees',
        },
        400,
      ),
    );

    await expect(fetchEmployeesPage({ cursor: '@@nope@@' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createEmployee', () => {
  it('POSTs the body to /employees and returns the representation', async () => {
    const representation = employee();
    fetchMock.mockResolvedValue(jsonResponse(representation, 201));

    const result = await createEmployee({
      employeeNumber: 'emp-001',
      name: 'Ada Lovelace',
      department: 'Engineering',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/employees`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({ employeeNumber: 'emp-001', name: 'Ada Lovelace', department: 'Engineering' }),
    );
    expect(result).toEqual(representation);
  });

  it('surfaces the duplicate-number 409 as an ApiError with the server message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          statusCode: 409,
          message: 'An employee with employeeNumber "emp-001" already exists in this organization',
          error: 'ConflictException',
          timestamp: '2026-10-16T09:00:00.000Z',
          path: '/employees',
        },
        409,
      ),
    );

    await expect(createEmployee({ employeeNumber: 'emp-001', name: 'X' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('updateEmployee', () => {
  it('PATCHes only the given fields to the encoded id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(employee({ name: 'Ada King' })));

    const result = await updateEmployee('row-1', { name: 'Ada King' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/employees/row-1`);
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ name: 'Ada King' }));
    expect(result.name).toBe('Ada King');
  });
});

describe('archiveEmployee', () => {
  it('DELETEs the record and tolerates the bodiless 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(archiveEmployee('row-1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/employees/row-1`);
    expect(init.method).toBe('DELETE');
  });
});
