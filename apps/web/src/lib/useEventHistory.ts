import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventStatusNotification } from '@repo/shared';

import { fetchEventStatus, fetchEventsPage } from '../api/events';
import { isTerminal } from './status';
import { useEventStream } from './useEventStream';
import type { EventListQuery, EventType, LifecycleStatus } from './types';

/** Fixed fallback-polling interval for non-terminal history rows. */
export const POLL_INTERVAL_MS = 3000;

/** Page size the UI walks with; the server default (20) matches. */
const PAGE_SIZE = 20;

/**
 * One row of the history view: the server's list row plus the fields the
 * per-row `GET /events/{id}` polls hydrate (attempt count) or flag (a failed
 * poll renders the row Unavailable). The list endpoint deliberately serves no
 * attempt trail, so the attempt count starts at 0 and fills on the first
 * successful poll — including for rows that were ALREADY terminal when listed,
 * which are polled exactly once for that hydration and never again.
 */
export interface HistoryRow {
  id: string;
  eventType: EventType;
  employeeId: string;
  sequence: number;
  status: LifecycleStatus;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  /** Recorded attempt count (trail length at the last poll); 0 until polled. */
  attempts: number;
  /** Set when the last poll failed (network error or 404) → row unavailable. */
  error?: string;
  /** True once a detail poll has answered for this row at least once. */
  hydrated?: boolean;
}

/** The filter controls of the history view; '' means the filter is unset. */
export interface HistoryFilters {
  status: LifecycleStatus | '';
  eventType: EventType | '';
  employeeId: string;
  /** Date input value (yyyy-mm-dd) or full ISO timestamp; '' = unbounded. */
  createdAfter: string;
  createdBefore: string;
}

export const EMPTY_FILTERS: HistoryFilters = {
  status: '',
  eventType: '',
  employeeId: '',
  createdAfter: '',
  createdBefore: '',
};

export function hasActiveFilters(filters: HistoryFilters): boolean {
  return (
    filters.status !== '' ||
    filters.eventType !== '' ||
    filters.employeeId.trim() !== '' ||
    filters.createdAfter.trim() !== '' ||
    filters.createdBefore.trim() !== ''
  );
}

function toRow(item: {
  id: string;
  eventType: EventType;
  employeeId: string;
  sequence: number;
  status: LifecycleStatus;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}): HistoryRow {
  return { ...item, attempts: 0 };
}

function toQuery(filters: HistoryFilters, cursor: string | null): EventListQuery {
  const query: EventListQuery = {};
  if (filters.status) query.status = filters.status;
  if (filters.eventType) query.eventType = filters.eventType;
  if (filters.employeeId.trim()) query.employeeId = filters.employeeId.trim();
  if (filters.createdAfter.trim()) query.createdAfter = filters.createdAfter.trim();
  if (filters.createdBefore.trim()) {
    const value = filters.createdBefore.trim();
    // A date-only upper bound is inclusive through the END of that day —
    // "created before 2026-09-01" reads as "before September is over".
    query.createdBefore = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T23:59:59.999Z`
      : value;
  }
  if (cursor) query.cursor = cursor;
  return query;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

export interface UseEventHistoryOptions {
  /**
   * Pins the `status` filter for the hook's whole life (the dead-letter view):
   * the initial selection and every re-fetch always carry it, and `setFilter`
   * ignores status changes instead of lifting the pin.
   */
  lockedStatus?: LifecycleStatus;
}

/**
 * The server-driven event history (frontend-app, events-query-api): rows come
 * from `GET /events` through the authenticated client, never from local
 * persistence. The hook owns the current filters and the accumulated pages in
 * component state; changing a filter re-fetches page one, load-more appends the
 * page its `nextCursor` points at (keyset — stable under concurrent writes),
 * and `refresh()` re-fetches page one (what a fresh submission triggers).
 *
 * Status updates arrive over the event-status-stream (frontend-app, see
 * `useEventStream`): each notification updates the matching rendered row's
 * badge in place, and a terminal notification hydrates the row's attempt count
 * with exactly one follow-up `GET /events/{id}`. While the stream is healthy
 * there is NO fixed-cadence polling; when it is down the hook degrades to the
 * former behavior — every eligible row polled on the fixed cadence with
 * per-row failure isolation — until the stream reconnects (whereupon page one
 * is re-fetched to close any gap the outage hid).
 */
export function useEventHistory(options: UseEventHistoryOptions = {}) {
  const lockedStatus = options.lockedStatus;
  const [filters, setFilters] = useState<HistoryFilters>(
    lockedStatus ? { ...EMPTY_FILTERS, status: lockedStatus } : EMPTY_FILTERS,
  );
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Monotonic sequence guarding against out-of-order responses: only the
  // latest request's page is ever applied (a filter change mid-flight drops
  // the stale page instead of mixing selections).
  const requestSeq = useRef(0);
  const loadingMoreRef = useRef(false);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const fetchFirstPage = useCallback(async () => {
    const seq = ++requestSeq.current;
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadError(null);
    setLoadingMore(false);
    try {
      const page = await fetchEventsPage({
        ...toQuery(filtersRef.current, null),
        limit: PAGE_SIZE,
      });
      if (seq !== requestSeq.current) return;
      setRows(page.data.map(toRow));
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setRows([]);
      setNextCursor(null);
      setLoadError(errorMessage(error));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // Page one on mount and on every filter change — server data is the only
  // source, so a filter change is a re-fetch, never a client-side narrow.
  useEffect(() => {
    void fetchFirstPage();
  }, [filters, fetchFirstPage]);

  /** Re-fetch page one for the CURRENT filters (used after a submission). */
  const refresh = useCallback(async () => {
    await fetchFirstPage();
  }, [fetchFirstPage]);

  /** Change one filter; the page-one effect does the re-fetch. */
  const setFilter = useCallback(
    <K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) => {
      if (key === 'status' && lockedStatus !== undefined && value !== lockedStatus) {
        // The status pin (dead-letter view) is not user-liftable.
        return;
      }
      setFilters((prev) =>
        prev[key] === value ? prev : { ...prev, [key]: value },
      );
    },
    [lockedStatus],
  );

  const clearFilters = useCallback(() => {
    setFilters(
      lockedStatus ? { ...EMPTY_FILTERS, status: lockedStatus } : EMPTY_FILTERS,
    );
  }, [lockedStatus]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || nextCursor === null) return;
    const seq = requestSeq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchEventsPage({
        ...toQuery(filtersRef.current, nextCursor),
        limit: PAGE_SIZE,
      });
      // A filter change (or refresh) since the call started discards the page.
      if (seq !== requestSeq.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((row) => row.id));
        return [...prev, ...page.data.map(toRow).filter((row) => !seen.has(row.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      // Load-more failures keep the rows already on screen; the button area
      // surfaces the error so the user can retry the append.
      if (seq !== requestSeq.current) return;
      setLoadError(errorMessage(error));
      setNextCursor(null);
    } finally {
      if (seq === requestSeq.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [nextCursor]);

  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  /**
   * Applies one stream notification (frontend-app): a badge update in place
   * for the matching row — notifications for events not in the rendered list
   * add no row — and, on a terminal notification, a single follow-up
   * `GET /events/{id}` that records the attempt count; that row is then
   * untracked while the stream stays healthy.
   */
  const applyNotification = useCallback((notification: EventStatusNotification) => {
    // Lookup on the latest-rows ref: the side effect (one hydrating fetch)
    // must stay OUT of the state updater, which React may run more than once.
    const row = rowsRef.current.find((entry) => entry.id === notification.eventId);
    if (!row) return;
    const nextStatus = notification.status as LifecycleStatus;
    setRows((prev) =>
      prev.map((entry) =>
        entry.id === row.id ? { ...entry, status: nextStatus, error: undefined } : entry,
      ),
    );
    if (isTerminal(nextStatus) && !(row.status === nextStatus && row.hydrated)) {
      void fetchEventStatus(row.id).then(
        (res) =>
          setRows((current) =>
            current.map((entry) =>
              entry.id === row.id
                ? {
                    ...entry,
                    status: res.status,
                    sequence: res.sequence,
                    attempts: res.attempts.length,
                    error: undefined,
                    hydrated: true,
                  }
                : entry,
            ),
          ),
        () => undefined, // the badge already carries the committed state
      );
    }
  }, []);

  const { connected: streamConnected } = useEventStream({
    enabled: true,
    onNotification: applyNotification,
    // A reconnect replays nothing: re-fetch page one for the CURRENT filters
    // so anything the outage missed is corrected before live updates resume.
    onResync: fetchFirstPage,
  });

  // Polling fallback (frontend-app, "Stream loss degrades to the polling
  // fallback"): ONLY while the stream is disconnected or failing. Same
  // semantics as before the stream existed — single interval on a latest-rows
  // ref, firing immediately, per-row failure isolation. Once the stream
  // reconnects this effect tears down entirely: no fixed-cadence polling.
  useEffect(() => {
    if (streamConnected) return;
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      // Poll rows whose lifecycle can still move, and rows that have never
      // answered once (a row listed as terminal still owes its attempt count).
      const targets = rowsRef.current.filter(
        (row) => !isTerminal(row.status) || !row.hydrated,
      );
      if (targets.length === 0) return;
      inFlight = true;
      void Promise.allSettled(
        targets.map((row) =>
          fetchEventStatus(row.id).then(
            (res) =>
              setRows((prev) =>
                prev.map((entry) =>
                  entry.id === row.id
                    ? {
                        ...entry,
                        status: res.status,
                        sequence: res.sequence,
                        attempts: res.attempts.length,
                        error: undefined,
                        hydrated: true,
                      }
                    : entry,
                ),
              ),
            (error: unknown) =>
              setRows((prev) =>
                prev.map((entry) =>
                  entry.id === row.id
                    ? // Not `hydrated` on failure: the row stays eligible for
                      // the next tick, so the list self-heals once the API is
                      // reachable again.
                      { ...entry, error: errorMessage(error) }
                    : entry,
                ),
              ),
          ),
        ),
      ).finally(() => {
        inFlight = false;
      });
    };

    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [streamConnected]);

  return {
    rows,
    filters,
    setFilter,
    clearFilters,
    refresh,
    loadMore,
    hasMore: nextCursor !== null,
    loading,
    loadingMore,
    loadError,
    streamConnected,
  };
}
