import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL, ApiError } from './client';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  fetchWebhookDeliveries,
  fetchWebhookEndpoints,
  updateWebhookEndpoint,
} from './webhooks';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

describe('webhooks api', () => {
  it('fetches endpoints without credentials in the payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 'ep-1', label: 'a', url: 'https://x', active: true }]));
    await fetchWebhookEndpoints();
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/webhook-endpoints`);
  });

  it('createWebhookEndpoint POSTs and returns the one-time secret', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'ep-1', label: 'a', url: 'https://x', active: true, signingSecret: 'sec-1' }),
    );
    const created = await createWebhookEndpoint({ label: 'a', url: 'https://x' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(created.signingSecret).toBe('sec-1');
  });

  it('updateWebhookEndpoint PATCHes and delete DELETEs by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'ep-1', active: false }));
    await updateWebhookEndpoint('ep-1', { active: false });
    expect(fetchMock.mock.calls[0][0]).toContain('/webhook-endpoints/ep-1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PATCH');

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteWebhookEndpoint('ep-1');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('fetches an endpoint\u2019s deliveries', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 'd-1', status: 'PENDING' }]));
    await fetchWebhookDeliveries('ep-1');
    expect(fetchMock.mock.calls[0][0]).toContain('/webhook-endpoints/ep-1/deliveries');
  });

  it('normalizes ApiError (404 cross-tenant, 409 duplicate label)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'nope' }, 404));
    await expect(createWebhookEndpoint({ label: 'x', url: 'https://y' })).rejects.toThrow(ApiError);
  });
});
