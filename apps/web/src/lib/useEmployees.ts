import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchEmployeesPage } from '../api/employees';
import type { Employee, EmployeeListQuery } from './types';

/** Page size the directory view walks with. */
const PAGE_SIZE = 50;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

export type EmployeeActiveFilter = 'all' | 'active' | 'archived';

/**
 * The server-driven employee directory (employee-directory, frontend-app):
 * rows come from `GET /employees` through the authenticated client, never from
 * local persistence. The hook owns the current filters and accumulated pages —
 * a filter/search change re-fetches page one, `loadMore` appends the page its
 * `nextCursor` points at (keyset on the employee number: stable under
 * concurrent registrations), and `refresh()` re-fetches page one after a
 * mutation. No polling: directory changes come from this user's actions.
 */
export function useEmployees() {
  const [activeFilter, setActiveFilter] = useState<EmployeeActiveFilter>('all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Employee[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Monotonic sequence guarding against out-of-order responses: only the
  // latest request's page is ever applied.
  const requestSeq = useRef(0);
  const filtersRef = useRef({ activeFilter, search });
  useEffect(() => {
    filtersRef.current = { activeFilter, search };
  }, [activeFilter, search]);

  const toQuery = (cursor: string | null): EmployeeListQuery => {
    const query: EmployeeListQuery = { limit: PAGE_SIZE };
    if (filtersRef.current.activeFilter === 'active') query.active = true;
    if (filtersRef.current.activeFilter === 'archived') query.active = false;
    const term = filtersRef.current.search.trim();
    if (term) query.search = term;
    if (cursor) query.cursor = cursor;
    return query;
  };

  const fetchFirstPage = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await fetchEmployeesPage(toQuery(null));
      if (seq !== requestSeq.current) return;
      setRows(page.data);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setRows([]);
      setNextCursor(null);
      setLoadError(errorMessage(error));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
    // Re-fetched when the search term changes; the debounce lives in the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchFirstPage();
  }, [activeFilter, search, fetchFirstPage]);

  /** Re-fetch page one for the current filters (used after every mutation). */
  const refresh = useCallback(async () => {
    await fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore || nextCursor === null) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await fetchEmployeesPage(toQuery(nextCursor));
      if (seq !== requestSeq.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((row) => row.id));
        return [...prev, ...page.data.filter((row) => !seen.has(row.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      // Keep the rows already on screen; surface the error for a retry.
      if (seq !== requestSeq.current) return;
      setLoadError(errorMessage(error));
      setNextCursor(null);
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  return {
    rows,
    activeFilter,
    setActiveFilter,
    search,
    setSearch,
    refresh,
    loadMore,
    hasMore: nextCursor !== null,
    loading,
    loadingMore,
    loadError,
  };
}

/**
 * A light, error-tolerant directory load for pickers: the ACTIVE employees
 * only (the submit form's employee field offers exactly who can receive
 * events). A load failure leaves the list empty — the picker shows its
 * placeholder and the directory view surfaces error state properly.
 */
export function useActiveEmployees(limit = 100) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // `loading` starts true (initial state); the effect only flips it around
    // the fetch, never synchronously at the top.
    let cancelled = false;
    fetchEmployeesPage({ active: true, limit })
      .then((page) => {
        if (!cancelled) setEmployees(page.data);
      })
      .catch(() => {
        if (!cancelled) setEmployees([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [limit]);

  return { employees, loading };
}
