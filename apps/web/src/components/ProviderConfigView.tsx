import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Plug,
  Globe,
  KeyRound,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Trash2,
  Save,
  Settings,
} from 'lucide-react';

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
 * The external payroll provider configuration view (OWNER-gated): swap the
 * organization between the built-in simulated provider and a real HTTP
 * endpoint. The credential is shown EXACTLY once — in the save success
 * banner — mirroring the API contract.
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
  const [copiedCredential, setCopiedCredential] = useState(false);

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

  const httpReady =
    mode === 'SIMULATED' || (baseUrl.trim() !== '' && credential.trim().length >= 6);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!httpReady || saving) return;
    setSaving(true);
    setSavedOnce(null);
    const result = await save({
      mode,
      ...(mode === 'HTTP' ? { baseUrl: baseUrl.trim(), credential: credential.trim() } : {}),
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

  function copyCredential() {
    if (!savedOnce) return;
    void navigator.clipboard.writeText(savedOnce).then(() => {
      setCopiedCredential(true);
      setTimeout(() => setCopiedCredential(false), 2000);
    });
  }

  // Non-owner view
  if (!isOwner) {
    return (
      <section className="mx-auto max-w-2xl" data-testid="provider-forbidden">
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Settings size={24} className="text-muted-foreground/50" />
          </div>
          <h1 className="text-lg font-semibold">Provider configuration</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Only the organization's <span className="font-medium text-foreground">Owner</span>{' '}
            can configure the external payroll provider. Contact your Owner to change this setting.
          </p>
        </div>
      </section>
    );
  }

  const showForm = state.kind === 'ready' || state.kind === 'unconfigured';

  return (
    <section className="mx-auto max-w-2xl space-y-8" data-testid="provider-view">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Payroll provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where processed payroll changes are executed. Changes apply to the very next event —
          no restart required.
        </p>
      </div>

      {/* Error */}
      {actionError && (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="provider-action-error"
        >
          <AlertTriangle size={15} className="shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{actionError}</p>
        </div>
      )}

      {/* Loading */}
      {state.kind === 'loading' && (
        <div className="space-y-3">
          <div className="skeleton h-20 rounded-2xl" />
          <div className="skeleton h-64 rounded-2xl" />
        </div>
      )}

      {showForm && (
        <div className="space-y-5">
          {/* Current status card */}
          <div
            className={`flex items-center gap-4 rounded-2xl border p-5 ${
              state.kind === 'ready' && state.config.mode === 'HTTP'
                ? 'border-primary/25 bg-primary/5'
                : 'border-border bg-card'
            }`}
            data-testid="provider-current"
          >
            <div
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
                state.kind === 'ready' && state.config.mode === 'HTTP'
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {state.kind === 'ready' && state.config.mode === 'HTTP' ? (
                <Globe size={22} />
              ) : (
                <Plug size={22} />
              )}
            </div>
            <div>
              <p className="font-semibold">
                {state.kind === 'ready'
                  ? state.config.mode === 'HTTP'
                    ? 'External HTTP endpoint'
                    : 'Simulated provider (simulated)'
                  : 'Simulated provider (simulated default)'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {state.kind === 'ready' && state.config.baseUrl
                  ? state.config.baseUrl
                  : state.kind === 'ready' && state.config.mode === 'SIMULATED'
                    ? 'Built-in provider — processes events locally.'
                    : 'No configuration saved yet — using built-in provider.'}
              </p>
            </div>
            {state.kind === 'ready' && (
              <span className="ml-auto rounded-full border border-emerald-500/30 bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Active
              </span>
            )}
          </div>

          {/* Configuration form */}
          <div className="rounded-2xl border border-border bg-card p-6">
            <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold">
              <Settings size={14} className="text-muted-foreground" />
              Change provider
            </h2>
            <form className="space-y-5" onSubmit={handleSave} data-testid="provider-form">
              <div>
                <span className="mb-1.5 block text-sm font-medium">Provider mode</span>
                <Select value={mode} onValueChange={(v) => setMode(v as 'SIMULATED' | 'HTTP')}>
                  <SelectTrigger className="w-72" data-testid="provider-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SIMULATED">
                      <div className="flex items-center gap-2">
                        <Plug size={14} />
                        Simulated (built-in provider)
                      </div>
                    </SelectItem>
                    <SelectItem value="HTTP">
                      <div className="flex items-center gap-2">
                        <Globe size={14} />
                        External HTTP endpoint
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {mode === 'HTTP' && (
                <div className="space-y-4">
                  <Input
                    label="Endpoint URL"
                    value={baseUrl}
                    onChange={setBaseUrl}
                    placeholder="https://payroll.acme.example/api/effects"
                    leftIcon={<Globe size={15} />}
                    data-testid="provider-base-url"
                  />
                  <div>
                    <Input
                      label="Credential (bearer token)"
                      type="password"
                      value={credential}
                      onChange={setCredential}
                      placeholder="sk_live_…"
                      autoComplete="off"
                      leftIcon={<KeyRound size={15} />}
                      data-testid="provider-credential"
                    />
                    <p className="mt-1.5 px-1 text-xs text-muted-foreground">
                      Sent as <code>Authorization: Bearer …</code> on every request. Shown once
                      after saving — store it immediately.
                    </p>
                  </div>
                </div>
              )}

              {/* One-time credential display */}
              {savedOnce && (
                <div
                  className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3"
                  data-testid="provider-credential-once"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <AlertTriangle size={14} className="text-amber-600" />
                    <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                      Saved — copy the credential now
                    </p>
                  </div>
                  <p className="mb-3 text-xs text-muted-foreground">
                    This is the only time it will be displayed.
                  </p>
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                    <code className="flex-1 select-all break-all font-mono text-[11px] text-foreground">
                      {savedOnce}
                    </code>
                    <button
                      type="button"
                      onClick={copyCredential}
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      title="Copy credential"
                    >
                      {copiedCredential ? (
                        <CheckCircle2 size={14} className="text-emerald-600" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* Actions */}
              {savedOnce === null && (
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!httpReady || busy || saving}
                    data-testid="provider-save"
                    className="gap-2"
                  >
                    <Save size={14} />
                    {saving ? 'Saving…' : 'Save configuration'}
                  </Button>
                  {state.kind === 'ready' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-2 text-destructive hover:bg-destructive/10"
                      disabled={busy || saving}
                      onClick={() => void handleDelete()}
                      data-testid="provider-delete"
                    >
                      <Trash2 size={14} />
                      Reset to simulated
                    </Button>
                  )}
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
