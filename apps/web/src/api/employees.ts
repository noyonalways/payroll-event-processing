import { API_BASE_URL, JSON_HEADERS, request } from './client';
import type {
  CreateEmployeeBody,
  Employee,
  EmployeeListQuery,
  EmployeeListResponse,
  UpdateEmployeeBody,
} from '../lib/types';

// The transport (token attach + refresh-once-and-retry, error normalization)
// lives in ./client; re-exported so callers keep importing the error types
// from the surface they call.
export { API_BASE_URL, ApiError, NetworkError, SessionExpiredError } from './client';

/**
 * The employee-directory surface (employee-directory) over the authenticated
 * transport in ./client: token attach, refresh-once-and-retry, and structured
 * `ApiError`s for every non-2xx (400 validation, 409 duplicate number, 404
 * unknown/foreign id).
 */

/**
 * GET /employees — one page of the organization's directory, ordered by
 * employee number ascending. Filters combine with AND; `cursor` follows the
 * previous page's `nextCursor` for a stable, offset-free walk.
 */
export function fetchEmployeesPage(
  query: EmployeeListQuery = {},
): Promise<EmployeeListResponse> {
  const params = new URLSearchParams();
  if (query.active !== undefined) params.set('active', String(query.active));
  if (query.search) params.set('search', query.search);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return request<EmployeeListResponse>(
    `${API_BASE_URL}/employees${qs ? `?${qs}` : ''}`,
    { headers: JSON_HEADERS },
  );
}

/** POST /employees — register one employee (201; 409 on a taken number). */
export function createEmployee(body: CreateEmployeeBody): Promise<Employee> {
  return request<Employee>(`${API_BASE_URL}/employees`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** PATCH /employees/{id} — correct name/department/active (employeeNumber immutable). */
export function updateEmployee(
  id: string,
  body: UpdateEmployeeBody,
): Promise<Employee> {
  return request<Employee>(`${API_BASE_URL}/employees/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** DELETE /employees/{id} — archive (204, idempotent; never a hard delete). */
export async function archiveEmployee(id: string): Promise<void> {
  await request<void>(`${API_BASE_URL}/employees/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  });
}
