import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Webhook,
  Plus,
  AlertTriangle,
  CheckCircle2,
  X,
  Copy,
  Pause,
  Play,
  Trash2,
  ChevronDown,
  ChevronUp,
  Send,
  Clock,
  MailX,
  Tag,
  Link,
} from 'lucide-react';

import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import { AnimatedBadge } from '@repo/ui/animated-badge';
import { useWebhooks } from '../lib/useWebhooks';
import { getSession } from '../lib/session';
import type { WebhookDelivery } from '../lib/types';

const createdLabel = (iso: string) => iso.slice(0, 10);

const DELIVERY_CHIP: Record<WebhookDelivery['status'], { classes: string; icon: React.ReactNode }> = {
  DELIVERED: {
    classes: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
    icon: <CheckCircle2 size={11} />,
  },
  PENDING: {
    classes: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
    icon: <Clock size={11} />,
  },
  DEAD_LETTERED: {
    classes: 'border-destructive/30 bg-destructive/12 text-destructive',
    icon: <MailX size={11} />,
  },
};

function SkeletonEndpoint() {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="skeleton h-4 w-28 rounded" />
        <div className="skeleton h-5 w-14 rounded-full" />
      </div>
      <div className="skeleton h-3 w-48 rounded" />
    </div>
  );
}

/**
 * The webhook management view: register HTTPS callbacks, toggle/delete them,
 * and inspect every delivery with its append-only attempt trail.
 *
 * The signing secret appears EXACTLY once, in the create success banner.
 * Endpoint mutations render only for ADMIN/OWNER.
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
  const [copiedSecret, setCopiedSecret] = useState(false);

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

  function copySecret() {
    if (!secretOnce) return;
    void navigator.clipboard.writeText(secretOnce).then(() => {
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    });
  }

  return (
    <section className="space-y-8" data-testid="webhooks-view">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Webhooks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every terminal event outcome is POSTed — HMAC-signed — to your HTTPS endpoints,
          with automatic retries and a full delivery trail.
        </p>
      </div>

      {/* Create form */}
      {canManage && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Plus size={15} className="text-muted-foreground" />
            Register an endpoint
          </h2>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={handleCreate}
            data-testid="webhook-create-form"
          >
            <div className="min-w-40">
              <Input
                label="Label"
                value={label}
                onChange={setLabel}
                placeholder="my-hris"
                leftIcon={<Tag size={14} />}
                data-testid="webhook-label"
              />
            </div>
            <div className="min-w-72 flex-1">
              <Input
                label="HTTPS endpoint URL"
                value={url}
                onChange={setUrl}
                placeholder="https://integrator.example.com/payroll/hooks"
                leftIcon={<Link size={14} />}
                data-testid="webhook-url"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={!formFilled || busy || creating}
              data-testid="webhook-create"
              className="gap-2"
            >
              <Webhook size={14} />
              {creating ? 'Registering…' : 'Register endpoint'}
            </Button>
          </form>

          {/* One-time secret display */}
          {secretOnce && (
            <div
              className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3"
              data-testid="webhook-secret-once"
            >
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber-600" />
                <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                  Save the signing secret now — it's shown only once
                </p>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                HMAC-SHA256 signatures on every delivery use this secret. It cannot be retrieved again.
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <code className="flex-1 select-all break-all font-mono text-[11px] text-foreground">
                  {secretOnce}
                </code>
                <button
                  type="button"
                  onClick={copySecret}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Copy secret"
                >
                  {copiedSecret ? (
                    <CheckCircle2 size={14} className="text-emerald-600" />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error banners */}
      {actionError && (
        <div
          className="flex items-start justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="webhooks-action-error"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{actionError}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
            onClick={clearActionError}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {listError && (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="webhooks-list-error"
        >
          <AlertTriangle size={15} className="shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{listError}</p>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
          <div className="space-y-2">
            <SkeletonEndpoint />
            <SkeletonEndpoint />
          </div>
          <div className="skeleton h-40 rounded-2xl" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
          {/* Endpoints */}
          <div className="space-y-3" data-testid="endpoint-list">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Webhook size={14} className="text-muted-foreground" />
              Endpoints
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {endpoints.length}
              </span>
            </h2>

            {endpoints.length === 0 && (
              <div className="rounded-xl border border-dashed border-border bg-card py-8 text-center">
                <Webhook size={28} className="mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No endpoints registered yet.</p>
              </div>
            )}

            {endpoints.map((endpoint) => (
              <div
                key={endpoint.id}
                role="button"
                tabIndex={0}
                className={`w-full cursor-pointer rounded-xl border p-4 text-left transition-all duration-150 ${
                  endpoint.id === selectedEndpointId
                    ? 'border-primary/40 bg-primary/8 shadow-sm'
                    : 'border-border bg-card hover:border-primary/25 hover:shadow-sm'
                }`}
                onClick={() => selectEndpoint(endpoint.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectEndpoint(endpoint.id); }}
                data-testid={`endpoint-${endpoint.label}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{endpoint.label}</span>
                  <AnimatedBadge
                    status={endpoint.active ? 'success' : 'neutral'}
                    size="sm"
                  >
                    {endpoint.active ? 'Active' : 'Paused'}
                  </AnimatedBadge>
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {endpoint.url}
                </div>
                {canManage && (
                  <div className="mt-3 flex gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void update(endpoint.id, { active: !endpoint.active })}
                      data-testid={`endpoint-toggle-${endpoint.id}`}
                    >
                      {endpoint.active ? <Pause size={11} /> : <Play size={11} />}
                      {endpoint.active ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      type="button"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void remove(endpoint.id)}
                      data-testid={`endpoint-delete-${endpoint.id}`}
                    >
                      <Trash2 size={11} />
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Deliveries */}
          <div className="space-y-3" data-testid="delivery-list">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Send size={14} className="text-muted-foreground" />
              Deliveries
              {!selectedEndpointId && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  — select an endpoint
                </span>
              )}
            </h2>

            {!selectedEndpointId && (
              <div className="rounded-xl border border-dashed border-border bg-card py-8 text-center">
                <Send size={24} className="mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  Select an endpoint to inspect its delivery trail.
                </p>
              </div>
            )}

            {selectedEndpointId && deliveries.length === 0 && (
              <div className="rounded-xl border border-dashed border-border bg-card py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No deliveries recorded for this endpoint yet.
                </p>
              </div>
            )}

            {selectedEndpointId && deliveries.map((delivery) => {
              const chip = DELIVERY_CHIP[delivery.status];
              const isExpanded = selectedDelivery?.id === delivery.id;
              return (
                <div
                  key={delivery.id}
                  className="overflow-hidden rounded-xl border border-border bg-card"
                  data-testid={`delivery-${delivery.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        className="text-sm font-medium hover:text-primary"
                        onClick={() =>
                          selectDelivery(isExpanded ? null : delivery.id)
                        }
                        data-testid={`delivery-open-${delivery.id}`}
                      >
                        Event <code className="font-mono">{delivery.eventId.slice(0, 8)}…</code>
                        {' · '}
                        {delivery.terminalStatus.toLowerCase()}
                      </button>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {delivery.attempts} attempt(s) · {createdLabel(delivery.createdAt)}
                        {delivery.deliveredAt
                          ? ` · delivered ${createdLabel(delivery.deliveredAt)}`
                          : ''}
                        {delivery.nextAttemptAt && delivery.status === 'PENDING'
                          ? ` · next retry ${createdLabel(delivery.nextAttemptAt)}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${chip.classes}`}
                      >
                        {chip.icon}
                        {delivery.status.toLowerCase()}
                        {delivery.status === 'DEAD_LETTERED' && delivery.deadLetterReason
                          ? ` · ${delivery.deadLetterReason}`
                          : ''}
                      </span>
                      <button
                        type="button"
                        className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                        onClick={() => selectDelivery(isExpanded ? null : delivery.id)}
                        title={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded delivery detail */}
                  {isExpanded && (
                    <div
                      className="border-t border-border bg-muted/30 px-4 py-4"
                      data-testid="delivery-detail"
                    >
                      {/* Attempt trail */}
                      <div className="mb-4">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Attempt trail
                        </p>
                        {delivery.attemptTrail.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No attempts recorded yet.</p>
                        ) : (
                          <ol className="relative space-y-2 border-l-2 border-border pl-4">
                            {delivery.attemptTrail.map((attempt) => (
                              <li key={attempt.id} className="text-xs font-mono">
                                <div className="absolute -left-[5px] mt-1 h-2 w-2 rounded-full border-2 border-background bg-border" />
                                <span className="font-semibold">#{attempt.attemptNumber}</span>{' '}
                                <span
                                  className={
                                    attempt.outcome === 'DELIVERED'
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-destructive'
                                  }
                                >
                                  {attempt.outcome}
                                </span>
                                {attempt.responseStatus
                                  ? ` · ${attempt.responseStatus}`
                                  : attempt.error
                                    ? ` · ${attempt.error}`
                                    : ''}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>

                      {/* Payload */}
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Delivered payload
                        </p>
                        <pre className="max-h-48 overflow-auto rounded-xl border border-border bg-background p-3 font-mono text-[11px] text-foreground">
                          {JSON.stringify(delivery.payload, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
