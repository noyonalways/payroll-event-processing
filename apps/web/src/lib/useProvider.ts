import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  NetworkError,
  deleteProviderConfig as deleteProviderConfigApi,
  fetchProviderConfig,
  upsertProviderConfig as upsertProviderConfigApi,
} from '../api/provider';
import type { ProviderConfig } from './types';

export const errorOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof NetworkError
    ? error.message
    : error instanceof SessionExpiredError
      ? 'Session expired — sign in again'
      : error instanceof Error
        ? error.message
        : 'Request failed';

/** The fetch state of the org's provider configuration. */
export type ProviderConfigState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unconfigured' }
  | { kind: 'ready'; config: ProviderConfig };

/**
 * The provider configuration behind ProviderConfigView
 * (real-provider-adapter UI): a 404 from the read means the SIMULATED default
 * is active — rendered as a friendly state, not an error.
 *
 * The save result's `credential` is returned to the CALLER for the show-once
 * banner; the hook never stores or re-fetches it.
 */
export function useProviderConfig() {
  const [state, setState] = useState<ProviderConfigState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const config = await fetchProviderConfig();
      setState({ kind: 'ready', config });
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        setState({ kind: 'unconfigured' });
        return;
      }
      setState({ kind: 'error', message: errorOf(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (
      body: Parameters<typeof upsertProviderConfigApi>[0],
    ): Promise<{ credential: string } | null> => {
      setBusy(true);
      setActionError(null);
      try {
        const saved = await upsertProviderConfigApi(body);
        await refresh();
        return { credential: saved.credential };
      } catch (error) {
        setActionError(errorOf(error));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await deleteProviderConfigApi();
      await refresh();
      return true;
    } catch (error) {
      setActionError(errorOf(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const clearActionError = useCallback(() => setActionError(null), []);

  return { state, busy, actionError, save, remove, clearActionError, refresh };
}
