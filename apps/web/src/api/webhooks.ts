import { API_BASE_URL, JSON_HEADERS, request } from './client';
import type {
  CreateWebhookBody,
  UpdateWebhookBody,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from '../lib/types';

// The transport (token attach + refresh-once-and-retry, error normalization)
// lives in ./client; re-exported so callers keep importing the error types
// from the surface they call.
export { API_BASE_URL, ApiError, NetworkError, SessionExpiredError } from './client';

/**
 * Webhook endpoint management + delivery observability
 * (integrator-webhooks). Endpoint CRUD is ADMIN-gated; delivery READS are open
 * to every member. The signing secret is returned once — by create ONLY.
 * Every dead-token-free 404 (unknown id / foreign org) surfaces as ApiError.
 */

/** GET /webhook-endpoints — the organization's endpoints (no secrets). */
export function fetchWebhookEndpoints(): Promise<WebhookEndpoint[]> {
  return request<WebhookEndpoint[]>(`${API_BASE_URL}/webhook-endpoints`, {
    headers: JSON_HEADERS,
  });
}

/** POST /webhook-endpoints — register one callback; 201 carries the secret once. */
export function createWebhookEndpoint(
  body: CreateWebhookBody,
): Promise<WebhookEndpointCreated> {
  return request<WebhookEndpointCreated>(`${API_BASE_URL}/webhook-endpoints`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** PATCH /webhook-endpoints/{id} — label/URL/active updates (secret unpatachable). */
export function updateWebhookEndpoint(
  id: string,
  body: UpdateWebhookBody,
): Promise<WebhookEndpoint> {
  return request<WebhookEndpoint>(
    `${API_BASE_URL}/webhook-endpoints/${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) },
  );
}

/** DELETE /webhook-endpoints/{id} — pending deliveries die with it (204). */
export function deleteWebhookEndpoint(id: string): Promise<void> {
  return request<void>(`${API_BASE_URL}/webhook-endpoints/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** GET /webhook-endpoints/{id}/deliveries — newest-first, with attempt trails. */
export function fetchWebhookDeliveries(endpointId: string): Promise<WebhookDelivery[]> {
  return request<WebhookDelivery[]>(
    `${API_BASE_URL}/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries`,
    { headers: JSON_HEADERS },
  );
}

/** GET /webhook-deliveries/{id} — one delivery with its full attempt trail. */
export function fetchWebhookDelivery(id: string): Promise<WebhookDelivery> {
  return request<WebhookDelivery>(
    `${API_BASE_URL}/webhook-deliveries/${encodeURIComponent(id)}`,
    { headers: JSON_HEADERS },
  );
}
