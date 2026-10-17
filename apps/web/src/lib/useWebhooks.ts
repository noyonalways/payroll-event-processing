import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  NetworkError,
  SessionExpiredError,
  createWebhookEndpoint,
  deleteWebhookEndpoint as deleteWebhookEndpointApi,
  fetchWebhookDeliveries,
  fetchWebhookEndpoints,
  updateWebhookEndpoint as updateWebhookEndpointApi,
} from '../api/webhooks';
import type {
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from './types';

export const errorOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof NetworkError
    ? error.message
    : error instanceof SessionExpiredError
      ? 'Session expired — sign in again'
      : error instanceof Error
        ? error.message
        : 'Request failed';

/**
 * Webhook endpoints + their deliveries behind WebhooksView
 * (integrator-webhooks UI). Server-driven like every list in this app —
 * nothing is invented locally; every mutation re-fetches.
 *
 * The create result's `signingSecret` is returned to the CALLER for the
 * show-once hand-off banner; the hook never stores or re-fetches it.
 */
export function useWebhooks() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<WebhookDelivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDeliveries = useCallback(async (endpointId: string | null) => {
    if (!endpointId) {
      setDeliveries([]);
      return;
    }
    try {
      setDeliveries(await fetchWebhookDeliveries(endpointId));
    } catch (error) {
      setActionError(errorOf(error));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchWebhookEndpoints();
      setEndpoints(next);
      setListError(null);
      // Keep the selection if it still exists; otherwise pick the first.
      const kept =
        next.find((endpoint) => endpoint.id === selectedEndpointId)?.id ??
        next[0]?.id ??
        null;
      setSelectedEndpointId(kept);
      await loadDeliveries(kept);
    } catch (error) {
      setListError(errorOf(error));
    } finally {
      setLoading(false);
    }
    // selectedEndpointId deliberately excluded — refresh must not retrigger on selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDeliveries]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withAction = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        await refresh();
        return true;
      } catch (error) {
        setActionError(errorOf(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const create = useCallback(
    async (
      label: string,
      url: string,
    ): Promise<WebhookEndpointCreated | null> => {
      setBusy(true);
      setActionError(null);
      try {
        const created = await createWebhookEndpoint({ label, url });
        await refresh();
        return created;
      } catch (error) {
        setActionError(errorOf(error));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const update = useCallback(
    (id: string, body: { url?: string; active?: boolean }) =>
      withAction(() => updateWebhookEndpointApi(id, body)),
    [withAction],
  );

  const remove = useCallback(
    (id: string) => withAction(() => deleteWebhookEndpointApi(id)),
    [withAction],
  );

  const selectEndpoint = useCallback(
    (id: string) => {
      setSelectedEndpointId(id);
      setSelectedDelivery(null);
      void loadDeliveries(id);
    },
    [loadDeliveries],
  );

  const selectDelivery = useCallback(
    (id: string | null) => {
      const found =
        id === null ? null : (deliveries.find((d) => d.id === id) ?? null);
      setSelectedDelivery(found);
    },
    [deliveries],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    endpoints,
    deliveries,
    selectedEndpointId,
    selectedDelivery,
    loading,
    listError,
    actionError,
    busy,
    create,
    update,
    remove,
    selectEndpoint,
    selectDelivery,
    clearActionError,
    refresh,
  };
}
