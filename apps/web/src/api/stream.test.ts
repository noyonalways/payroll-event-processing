import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL, NetworkError } from './client';
import { consumeSseBuffer, openEventStream } from './stream';

const notification = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org-1',
  eventId: 'evt-1',
  eventType: 'BANK_ACCOUNT_CHANGE',
  employeeId: 'emp-1',
  sequence: 1,
  status: 'success',
  occurredAt: '2026-10-16T10:00:00.000Z',
  ...overrides,
});

const frame = (n: Record<string, unknown>) =>
  `event: lifecycle\ndata: ${JSON.stringify(n)}\n\n`;

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Left open: a live stream only ends when the test closes the client.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('consumeSseBuffer (frame parser)', () => {
  it('parses a complete data frame and returns the empty remainder', () => {
    const collected: string[] = [];
    const rest = consumeSseBuffer(frame(notification()), (n) =>
      collected.push(JSON.stringify(n)),
    );
    expect(rest).toBe('');
    expect(collected).toHaveLength(1);
    expect(JSON.parse(collected[0]!)).toMatchObject({
      eventId: 'evt-1',
      status: 'success',
    });
  });

  it('buffers partial frames: a chunk split mid-frame dispatches only after the blank line', () => {
    const collected: string[] = [];
    const emit = (buffer: string) => consumeSseBuffer(buffer, (n) => collected.push(JSON.stringify(n)));
    const full = frame(notification());
    const remainder = emit(full.slice(0, 20));
    expect(collected).toHaveLength(0);
    expect(emit(remainder + full.slice(20))).toBe('');
    expect(collected).toHaveLength(1);
  });

  it('ignores comment liveness lines and frames without data', () => {
    const collected: string[] = [];
    const rest = consumeSseBuffer(
      ': connected\n\n: heartbeat 2026-10-16T10:00:00.000Z\n\nevent: ping\n\n',
      (n) => collected.push(JSON.stringify(n)),
    );
    expect(rest).toBe('');
    expect(collected).toHaveLength(0);
  });

  it('drops a malformed data payload without breaking the stream', () => {
    const collected: string[] = [];
    const rest = consumeSseBuffer(
      'data: not-json-at-all\n\n' + frame(notification()),
      (n) => collected.push(JSON.stringify(n)),
    );
    expect(collected).toHaveLength(1);
    expect(rest).toBe('');
  });

  it('tolerates CRLF framing', () => {
    const collected: string[] = [];
    const crlf = frame(notification()).replaceAll('\n\n', '\r\n\r\n');
    const rest = consumeSseBuffer(crlf, (n) => collected.push(JSON.stringify(n)));
    expect(collected).toHaveLength(1);
    expect(rest).toBe('');
  });
});

describe('openEventStream', () => {
  it('connects with the stream Accept header and dispatches notifications', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([': connected\n\n', frame(notification()), ': heartbeat\n\n']),
    );
    const onOpen = vi.fn();
    const onNotification = vi.fn();
    const onDisconnect = vi.fn();

    const stream = openEventStream({ onOpen, onNotification, onDisconnect });
    await vi.waitFor(() => expect(onNotification).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/events/stream`);
    expect(init.headers).toMatchObject({ Accept: 'text/event-stream' });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-1', status: 'success' }),
    );
    expect(onDisconnect).not.toHaveBeenCalled();
    stream.close();
  });

  it('close() releases the connection silently: no disconnect callback', async () => {
    fetchMock.mockResolvedValue(sseResponse([': connected\n\n']));
    const onOpen = vi.fn();
    const onNotification = vi.fn();
    const onDisconnect = vi.fn();

    const stream = openEventStream({ onOpen, onNotification, onDisconnect });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('a clean server-side end reports `ended`', async () => {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(frame(notification())));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    const onDisconnect = vi.fn();
    openEventStream({
      onOpen: () => {},
      onNotification: () => {},
      onDisconnect,
    });

    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledWith('ended'));
  });

  it('a transport failure reports `error` with the wrapped cause', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const onDisconnect = vi.fn();

    openEventStream({ onOpen: () => {}, onNotification: () => {}, onDisconnect });

    // The client normalizes fetch rejections into NetworkError; the stream
    // surfaces it on the disconnect channel.
    await vi.waitFor(() =>
      expect(onDisconnect).toHaveBeenCalledWith('error', expect.any(NetworkError)),
    );
  });

  it('a rejected (non-2xx) response surfaces the structured error, not a stream', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 401,
          message: 'Unauthorized',
          error: 'UnauthorizedException',
          timestamp: '2026-10-16T10:00:00.000Z',
          path: '/events/stream',
        }),
        { status: 401 },
      ),
    );
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();

    openEventStream({ onOpen, onNotification: () => {}, onDisconnect });

    await vi.waitFor(() =>
      expect(onDisconnect).toHaveBeenCalledWith('error', expect.anything()),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });
});
