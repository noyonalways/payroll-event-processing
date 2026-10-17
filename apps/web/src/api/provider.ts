import { API_BASE_URL, JSON_HEADERS, request } from './client';
import type {
  ProviderConfig,
  ProviderConfigSaved,
  UpsertProviderConfigBody,
} from '../lib/types';

// The transport (token attach + refresh-once-and-retry, error normalization)
// lives in ./client; re-exported so callers keep importing the error types
// from the surface they call.
export { API_BASE_URL, ApiError, NetworkError, SessionExpiredError } from './client';

/**
 * Per-organization external payroll provider configuration
 * (real-provider-adapter), OWNER-gated. The credential is returned in full
 * EXACTLY once — by the PUT that set it — and every read redacts it. The
 * resolver re-reads this per event, so changes apply on the next processed
 * event with no restart.
 */

/** GET /provider-config — 404 ApiError when the simulated default is active. */
export function fetchProviderConfig(): Promise<ProviderConfig> {
  return request<ProviderConfig>(`${API_BASE_URL}/provider-config`, {
    headers: JSON_HEADERS,
  });
}

/** PUT /provider-config — create-or-replace (201 carries the credential once). */
export function upsertProviderConfig(
  body: UpsertProviderConfigBody,
): Promise<ProviderConfigSaved> {
  return request<ProviderConfigSaved>(`${API_BASE_URL}/provider-config`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** DELETE /provider-config — back to the simulated provider (204). */
export function deleteProviderConfig(): Promise<void> {
  return request<void>(`${API_BASE_URL}/provider-config`, { method: 'DELETE' });
}
