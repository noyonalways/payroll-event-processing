import type { EventStatusNotification } from '@repo/shared';
import { API_BASE_URL, fetchAuthorized } from './client';

/**
 * One open SSE connection to `GET /events/stream` (event-status-stream),
 * consumed over `fetch` because `EventSource` cannot send the `Authorization`
 * header and the stream keeps the bearer-token contract of every other
 * endpoint. The raw `Response` body is read incrementally: partial chunks are
 * buffered, complete frames are parsed and dispatched, comment lines
 * (`: heartbeat`, `: connected`) are swallowed as pure liveness, and a payload
 * that fails to parse as a notification is dropped — the read endpoints stay
 * the resynchronization path, so a bad frame is never worth breaking on.
 */
export interface EventStreamHandlers {
  /** The connection is established (response headers received). */
  onOpen: () => void;
  /** A parsed committed-transition notification. */
  onNotification: (notification: EventStatusNotification) => void;
  /**
   * The connection is gone: `ended` for a clean server-side close, `error` for
   * a transport failure. Never called after the caller closes the stream.
   */
  onDisconnect: (reason: 'ended' | 'error', error?: unknown) => void;
}

export interface EventStreamHandle {
  /** Idempotent close: aborts the fetch and silences further callbacks. */
  close(): void;
}

/** Malformed or non-event JSON is indistinguishable from a bad frame → drop. */
function asNotification(data: string): EventStatusNotification | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as EventStatusNotification).eventId === 'string'
    ) {
      return parsed as EventStatusNotification;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Consumes every COMPLETE frame in `buffer` (split on a blank line, tolerating
 * CRLF), dispatching `data:` payloads and ignoring comment lines, and returns
 * the trailing (possibly empty) partial frame to keep buffering. Split chunks
 * are handled by construction: the caller only ever passes complete frames
 * into dispatch.
 */
export function consumeSseBuffer(
  buffer: string,
  onNotification: (notification: EventStatusNotification) => void,
): string {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const lastBoundary = normalized.lastIndexOf('\n\n');
  const complete = lastBoundary === -1 ? '' : normalized.slice(0, lastBoundary + 2);
  const remainder = lastBoundary === -1 ? normalized : normalized.slice(lastBoundary + 2);

  for (const frame of complete.split('\n\n')) {
    if (!frame.trim()) continue;
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // comment — liveness only
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
      // `event:`/`id:` fields are accepted and ignored: one notification kind
      // flows on this stream, and nothing is replayed.
    }
    if (dataLines.length === 0) continue;
    const notification = asNotification(dataLines.join('\n'));
    if (notification) onNotification(notification);
  }
  return remainder;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' &&
        error !== null &&
        (error as { name?: string }).name === 'AbortError';
}

/**
 * Opens the stream. The connect is fire-and-forget (`onOpen`/`onDisconnect`
 * carry the lifecycle); `close()` tears it down silently.
 */
export function openEventStream(handlers: EventStreamHandlers): EventStreamHandle {
  const controller = new AbortController();
  let closedByCaller = false;

  void (async () => {
    try {
      const res = await fetchAuthorized(`${API_BASE_URL}/events/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (closedByCaller) return;
      handlers.onOpen();

      const reader = res.body?.getReader();
      if (!reader) {
        handlers.onDisconnect('error', new Error('stream response has no body'));
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (closedByCaller) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeSseBuffer(buffer, handlers.onNotification);
      }
      buffer += decoder.decode();
      consumeSseBuffer(buffer, handlers.onNotification);
      if (!closedByCaller) handlers.onDisconnect('ended');
    } catch (error) {
      // A caller-requested abort is the normal close path — silent.
      if (closedByCaller || isAbortError(error)) return;
      handlers.onDisconnect('error', error);
    }
  })();

  return {
    close() {
      closedByCaller = true;
      controller.abort();
    },
  };
}
