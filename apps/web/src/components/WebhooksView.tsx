import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import { useWebhooks } from '../lib/useWebhooks';
import { getSession } from '../lib/session';
import type { WebhookDelivery } from '../lib/types';

const createdLabel = (iso: string) => iso.slice(0, 10);

const deliveryStateVariant: Record<WebhookDelivery['status'], string> = {
  DELIVERED: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  PENDING: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  DEAD_LETTERED: 'bg-destructive/15 text-destructive border-destructive/30',
};

/**
 * The webhook management view (integrator-webhooks UI): register HTTPS
 * callbacks, toggle/delete them, and inspect every delivery with its
 * append-only attempt trail — integrators debug rejections without support.
 *
 * The signing secret appears EXACTLY once, in the create success banner
 * (mirroring the API contract); no list, read, or re-render can produce it.
 * Endpoint mutations render only for ADMIN/OWNER — the same thresholds the
 * API's role gates enforce, so members see the read-only surfaces only.
 */
export function WebhooksView() {
  const {
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
  } = useWebhooks();

  const session = getSession();
  const role = session?.role ?? 'MEMBER';
  const canManage = role === 'OWNER' || role === 'ADMIN';

  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [secretOnce, setSecretOnce] = useState<string | null>(null);

  const formFilled = label.trim() !== '' && url.trim() !== '';

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!formFilled || creating) return;
    setCreating(true);
    setSecretOnce(null);
    const created = await create(label.trim(), url.trim());
    if (created) {
      setLabel('');
      setUrl('');
      setSecretOnce(created.signingSecret);
    }
    setCreating(false);
  }

  return (
    <section className="space-y-6" data-testid="webhooks-view">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Webhooks</h2>
        <p className="text-sm text-muted-foreground">
          Every terminal event outcome is POSTed — signed — to your HTTPS
          endpoints, with retries and a full delivery trail.
        </p>
      </div>

      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={handleCreate}
          data-testid="webhook-create-form"
        >
          <div className="min-w-40">
            <Input
              label="Label"
              value={label}
              onChange={setLabel}
              placeholder="my-hris"
              data-testid="webhook-label"
            />
          </div>
          <div className="min-w-72 flex-1">
            <Input
              label="HTTPS URL"
              value={url}
              onChange={setUrl}
              placeholder="https://integrator.example.com/payroll/hooks"
              data-testid="webhook-url"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={!formFilled || busy || creating}
            data-testid="webhook-create"
          >
            {creating ? 'Registering…' : 'Register endpoint'}
          </Button>
        </form>
      )}

      {secretOnce && (
        <div
          className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm"
          data-testid="webhook-secret-once"
        >
          <p className="font-medium">Endpoint registered — save the signing secret NOW.</p>
          <p className="text-xs text-muted-foreground">
            HMAC-SHA256 signatures on every delivery use it. It is shown this one
            time and can never be retrieved again.
          </p>
          <div className="mt-1 select-all font-mono text-xs break-all">{secretOnce}</div>
        </div>
      )}

      {actionError && (
        <div
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="webhooks-action-error"
        >
          <span>{actionError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={clearActionError}
          >
            dismiss
          </Button>
        </div>
      )}

      {listError && (
        <p className="text-sm text-destructive" role="alert" data-testid="webhooks-list-error">
          {listError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="webhooks-loading">
          Loading…
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
          {/* ── Endpoints ───────────────────────────────── */}
          <div className="space-y-2" data-testid="endpoint-list">
            <h3 className="text-sm font-semibold">Endpoints</h3>
            {endpoints.length === 0 && (
              <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                No webhook endpoints yet.
              </p>
            )}
            {endpoints.map((endpoint) => (
              <button
                key={endpoint.id}
                type="button"
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  endpoint.id === selectedEndpointId
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border bg-card hover:border-primary/20'
                }`}
                onClick={() => selectEndpoint(endpoint.id)}
                data-testid={`endpoint-${endpoint.label}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{endpoint.label}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      endpoint.active
                        ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700'
                        : 'border-border bg-muted text-muted-foreground'
                    }`}
                  >
                    {endpoint.active ? 'active' : 'paused'}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {endpoint.url}
                </div>
                {canManage && (
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void update(endpoint.id, { active: !endpoint.active });
                      }}
                      data-testid={`endpoint-toggle-${endpoint.id}`}
                    >
                      {endpoint.active ? 'Pause' : 'Resume'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-destructive"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(endpoint.id);
                      }}
                      data-testid={`endpoint-delete-${endpoint.id}`}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* ── Deliveries ───────────────────────────────── */}
          <div className="space-y-2" data-testid="delivery-list">
            <h3 className="text-sm font-semibold">
              Deliveries {selectedEndpointId ? '(newest first)' : '— pick an endpoint'}
            </h3>
            {!selectedEndpointId && (
              <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                Select an endpoint to inspect its delivery trail.
              </p>
            )}
            {selectedEndpointId && deliveries.length === 0 && (
              <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                No deliveries recorded for this endpoint yet.
              </p>
            )}
            {selectedEndpointId &&
              deliveries.map((delivery) => (
                <div
                  key={delivery.id}
                  className="rounded-lg border border-border bg-card p-3"
                  data-testid={`delivery-${delivery.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      className="text-sm font-medium hover:underline"
                      onClick={() =>
                        selectDelivery(
                          selectedDelivery?.id === delivery.id ? null : delivery.id,
                        )
                      }
                      data-testid={`delivery-open-${delivery.id}`}
                    >
                      Event {delivery.eventId.slice(0, 8)}… ·{' '}
                      {delivery.terminalStatus.toLowerCase()}
                    </button>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${deliveryStateVariant[delivery.status]}`}
                    >
                      {delivery.status.toLowerCase()}
                      {delivery.status === 'DEAD_LETTERED' && delivery.deadLetterReason
                        ? ` · ${delivery.deadLetterReason}`
                        : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {delivery.attempts} attempt(s) · created{' '}
                    {createdLabel(delivery.createdAt)}
                    {delivery.deliveredAt
                      ? ` · delivered ${createdLabel(delivery.deliveredAt)}`
                      : ''}
                    {delivery.nextAttemptAt && delivery.status === 'PENDING'
                      ? ` · next retry ${createdLabel(delivery.nextAttemptAt)}`
                      : ''}
                  </p>

                  {selectedDelivery?.id === delivery.id && (
                    <div
                      className="mt-2 space-y-2 border-t border-border pt-2"
                      data-testid="delivery-detail"
                    >
                      <div className="text-xs">
                        <span className="font-medium">Attempt trail</span>
                        <ul className="mt-1 space-y-1">
                          {delivery.attemptTrail.length === 0 && (
                            <li className="text-muted-foreground">No attempts recorded yet.</li>
                          )}
                          {delivery.attemptTrail.map((attempt) => (
                            <li key={attempt.id} className="font-mono">
                              #{attempt.attemptNumber} {attempt.outcome}
                              {attempt.responseStatus
                                ? ` · ${attempt.responseStatus}`
                                : attempt.error
                                  ? ` · ${attempt.error}`
                                  : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="text-xs">
                        <span className="font-medium">Delivered payload</span>
                        <pre className="mt-1 max-h-40 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px]">
                          {JSON.stringify(delivery.payload, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
