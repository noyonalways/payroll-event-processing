import { useEffect, useRef, useState } from 'react';
import type { EventStatusNotification } from '@repo/shared';
import { openEventStream, type EventStreamHandle } from '../api/stream';

/**
 * One SSE subscription for the caller's whole lifetime (realtime-status,
 * frontend-app): while `enabled`, a single `GET /events/stream` connection is
 * kept open with reconnect/backoff — the stream replays nothing, so each
 * reconnection triggers `onResync` (a fresh page-one fetch from the read
 * endpoints) before live updates resume.
 */
export interface UseEventStreamOptions {
  enabled: boolean;
  onNotification: (notification: EventStatusNotification) => void;
  onResync?: () => void;
}

/** Backoff schedule for reconnect attempts; the last value repeats forever. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export interface UseEventStreamResult {
  /**
   * True while the stream is open (response received and frames flowing).
   * `false` means the caller is in the polling-fallback regime.
   */
  connected: boolean;
}

export function useEventStream({
  enabled,
  onNotification,
  onResync,
}: UseEventStreamOptions): UseEventStreamResult {
  const [connected, setConnected] = useState(false);
  // Latest callbacks via ref: the connection effect mounts once per `enabled`
  // and must not reconnect (or resubscribe) because a callback identity moved.
  const handlersRef = useRef({ onNotification, onResync });
  useEffect(() => {
    handlersRef.current = { onNotification, onResync };
  }, [onNotification, onResync]);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    let disposed = false;
    let handle: EventStreamHandle | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let everDisconnected = false;

    const scheduleReconnect = () => {
      const delay =
        RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)];
      attempts += 1;
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed) return;
      handle = openEventStream({
        onOpen: () => {
          if (disposed) return;
          attempts = 0;
          setConnected(true);
          // A reconnect replays nothing — resync once the pipe is live again.
          if (everDisconnected) handlersRef.current.onResync?.();
          everDisconnected = false;
        },
        onNotification: (notification) => {
          if (!disposed) handlersRef.current.onNotification(notification);
        },
        onDisconnect: () => {
          if (disposed) return;
          everDisconnected = true;
          setConnected(false);
          scheduleReconnect();
        },
      });
    };

    connect();

    return () => {
      disposed = true;
      handle?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}
