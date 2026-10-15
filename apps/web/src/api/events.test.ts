import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventStatusResponse } from '../lib/types';
import {
  API_BASE_URL,
  ApiError,
  NetworkError,
  fetchEventStatus,
  submitEvent,
} from './events';

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

const bankBody = {
  eventType: 'BANK_ACCOUNT_CHANGE',
  payload: {
    employeeId: 'emp-1',
    effectiveDate: '2026-09-01',
    iban: 'DE89370400440532013000',
  },
} as const;

describe('submitEvent', () => {
  it('POSTs the body to /events with a generated Idempotency-Key header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'e-1', status: 'received' }, 201),
    );

    const result = await submitEvent(bankBody);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/events`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(bankBody));
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': expect.any(String) as string,
    });
    expect(result.response).toEqual({ id: 'e-1', status: 'received' });
    expect(result.idempotencyKey).toBeTypeOf('string');
  });

  it('parses the 201 body and returns the supplied idempotency key verbatim', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'e-2', status: 'received' }, 201),
    );

    const result = await submitEvent(bankBody, 'key-123');

    expect(result.response).toEqual({ id: 'e-2', status: 'received' });
    expect(result.idempotencyKey).toBe('key-123');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Idempotency-Key': 'key-123' });
  });

  it('normalizes a 400 into a typed ApiError carrying the structured body', async () => {
    const errorBody = {
      statusCode: 400,
      message: ['iban: iban must be a valid IBAN (e.g. DE89 3704 0044 0532 0130 00)'],
      error: 'BadRequestException',
      timestamp: '2026-08-26T00:00:00.000Z',
      path: '/events',
    };
    fetchMock.mockResolvedValue(jsonResponse(errorBody, 400));

    let err: unknown;
    try {
      await submitEvent(bankBody, 'new-key');
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.statusCode).toBe(400);
    expect(apiError.message).toContain('iban');
    expect(apiError.body).toMatchObject(errorBody);
  });

  it('throws NetworkError when the request cannot reach the server', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(submitEvent(bankBody, 'key-1')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('fetchEventStatus', () => {
  const statusBody: EventStatusResponse = {
    id: 'e-1',
    eventType: 'BANK_ACCOUNT_CHANGE',
    employeeId: 'emp-1',
    sequence: 1,
    status: 'queued',
    payload: bankBody.payload,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:01.000Z',
    processedAt: null,
    result: null,
    attempts: [],
  };

  it('GETs /events/{id} and parses the status body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(statusBody));

    await expect(fetchEventStatus('e-1')).resolves.toEqual(statusBody);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/events/e-1`,
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('normalizes a 404 into an ApiError', async () => {
    const errorBody = {
      statusCode: 404,
      message: 'No payroll event matches id e-missing',
      error: 'NotFoundException',
      timestamp: '2026-08-26T00:00:00.000Z',
      path: '/events/e-missing',
    };
    fetchMock.mockResolvedValue(jsonResponse(errorBody, 404));

    await expect(fetchEventStatus('e-missing')).rejects.toMatchObject({
      statusCode: 404,
      body: errorBody,
    });
    await expect(fetchEventStatus('e-missing')).rejects.toBeInstanceOf(ApiError);
  });

  it('throws NetworkError on a failed poll', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchEventStatus('e-1')).rejects.toBeInstanceOf(NetworkError);
  });
});