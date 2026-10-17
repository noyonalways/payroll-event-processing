import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL, ApiError } from './client';
import {
  deleteProviderConfig,
  fetchProviderConfig,
  upsertProviderConfig,
} from './provider';

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

describe('provider api', () => {
  it('reads the configuration (404 → ApiError for the unconfigured state)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'HTTP', baseUrl: 'https://x' }));
    const config = await fetchProviderConfig();
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/provider-config`);
    expect(config).toEqual({ mode: 'HTTP', baseUrl: 'https://x' });

    fetchMock.mockResolvedValue(jsonResponse({ message: 'none' }, 404));
    await expect(fetchProviderConfig()).rejects.toThrow(ApiError);
  });

  it('PUT returns the credential-once payload', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ mode: 'HTTP', baseUrl: 'https://x', credential: 'cred-1' }, 201),
    );
    const saved = await upsertProviderConfig({
      mode: 'HTTP',
      baseUrl: 'https://x',
      credential: 'cred-1',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('PUT');
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ mode: 'HTTP', baseUrl: 'https://x', credential: 'cred-1' }),
    );
    expect(saved.credential).toBe('cred-1');
  });

  it('DELETE returns to the simulated default', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteProviderConfig();
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });
});
