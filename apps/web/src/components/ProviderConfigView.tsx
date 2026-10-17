import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select';
import { useProviderConfig } from '../lib/useProvider';
import { getSession } from '../lib/session';

/**
 * The external payroll provider configuration view
 * (real-provider-adapter UI, OWNER-gated): swap the organization between the
 * built-in simulated provider and a real HTTP endpoint, see which is
 * currently active, and return to simulated at any time. The resolver
 * re-reads per event, so a save applies to the very next processed event.
 *
 * The credential is shown EXACTLY once — in the save success banner —
 * mirroring the API contract; reads never return it, so this view also never
 * re-displays it.
 */
export function ProviderConfigView() {
  const { state, busy, actionError, save, remove } = useProviderConfig();

  const session = getSession();
  const isOwner = session?.role === 'OWNER';

  const [mode, setMode] = useState<'SIMULATED' | 'HTTP'>('SIMULATED');
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState<string | null>(null);

  // Mirror the loaded configuration into the form (once per load).
  useEffect(() => {
    if (state.kind === 'ready') {
      setMode(state.config.mode);
      setBaseUrl(state.config.baseUrl ?? '');
    }
    if (state.kind === 'unconfigured') {
      setMode('SIMULATED');
      setBaseUrl('');
    }
  }, [state]);

  const httpReady = mode === 'SIMULATED' || (baseUrl.trim() !== '' && credential.trim().length >= 6);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!httpReady || saving) return;
    setSaving(true);
    setSavedOnce(null);
    const result = await save({
      mode,
      ...(mode === 'HTTP'
        ? { baseUrl: baseUrl.trim(), credential: credential.trim() }
        : {}),
    });
    if (result) {
      setCredential('');
      setSavedOnce(result.credential);
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (saving) return;
    setSaving(true);
    setSavedOnce(null);
    await remove();
    setSaving(false);
  }

  if (!isOwner) {
    return (
      <section className="mx-auto max-w-2xl" data-testid="provider-forbidden">
        <h2 className="text-lg font-semibold tracking-tight">Provider configuration</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Only the organization's <span className="font-medium">OWNER</span> configures the
          external payroll provider.
        </p>
      </section>
    );
  }

  const showForm =
    state.kind === 'ready' || state.kind === 'unconfigured';

  return (
    <section className="mx-auto max-w-2xl space-y-5" data-testid="provider-view">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Payroll provider</h2>
        <p className="text-sm text-muted-foreground">
          Where processed payroll changes are executed. The change applies to the
          next processed event — no restart needed.
        </p>
      </div>

      {actionError && (
        <div
          className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="provider-action-error"
        >
          {actionError}
        </div>
      )}

      {state.kind === 'loading' && (
        <p className="text-sm text-muted-foreground" data-testid="provider-loading">
          Loading…
        </p>
      )}

      {showForm && (
        <>
          <div
            className="rounded-lg border border-border bg-card p-4 text-sm"
            data-testid="provider-current"
          >
            {state.kind === 'ready' ? (
              <>
                <span className="font-medium">
                  Current: {state.config.mode === 'HTTP' ? 'External HTTP endpoint' : 'Simulated provider'}
                </span>
                {state.config.baseUrl && (
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {state.config.baseUrl}
                  </div>
                )}
              </>
            ) : (
              <span className="font-medium">Current: simulated provider (default — nothing configured yet)</span>
            )}
          </div>

          <form
            className="space-y-4 rounded-xl border border-border bg-card p-5"
            onSubmit={handleSave}
            data-testid="provider-form"
          >
            <div>
              <span className="mb-1 block text-sm font-medium">Provider mode</span>
              <Select value={mode} onValueChange={(v) => setMode(v as 'SIMULATED' | 'HTTP')}>
                <SelectTrigger className="w-64" data-testid="provider-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SIMULATED">Simulated (built-in demo provider)</SelectItem>
                  <SelectItem value="HTTP">External HTTP endpoint</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === 'HTTP' && (
              <>
                <Input
                  label="Endpoint URL"
                  value={baseUrl}
                  onChange={setBaseUrl}
                  placeholder="https://payroll.acme.example/api/effects"
                  data-testid="provider-base-url"
                />
                <div>
                  <Input
                    label="Credential (bearer token sent on every call)"
                    type="password"
                    value={credential}
                    onChange={setCredential}
                    placeholder="sk_live_…"
                    autoComplete="off"
                    data-testid="provider-credential"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Shown once after saving — store it somewhere safe. Required for HTTP mode.
                  </p>
                </div>
              </>
            )}

            {savedOnce && (
              <div
                className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm"
                data-testid="provider-credential-once"
              >
                <p className="font-medium">Saved — the credential, exactly once:</p>
                <div className="mt-1 select-all font-mono text-xs break-all">{savedOnce}</div>
              </div>
            )}

            {savedOnce === null && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!httpReady || busy || saving}
                  data-testid="provider-save"
                >
                  {saving ? 'Saving…' : 'Save configuration'}
                </Button>
                {state.kind === 'ready' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={busy || saving}
                    onClick={() => void handleDelete()}
                    data-testid="provider-delete"
                  >
                    Delete — back to simulated
                  </Button>
                )}
              </div>
            )}
          </form>
        </>
      )}
    </section>
  );
}
