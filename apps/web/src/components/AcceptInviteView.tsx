import { useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, AlertTriangle, CheckCircle2, LogIn } from 'lucide-react';

import { ApiError, NetworkError, acceptInvitation } from '../api/members';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import type { AcceptInvitationResult } from '../lib/types';

const errorOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof NetworkError
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Acceptance failed';

/**
 * Extracts the invitation token from the invite link — both the canonical
 * in-app path (`/invite/<token>`) and the hash form (`#/invite/<token>`) work,
 * so the hand-off URL is valid however the SPA is hosted.
 */
export function invitationTokenFromLocation(
  pathname: string = window.location.pathname,
  hash: string = window.location.hash,
): string | null {
  const sources = [pathname, hash.replace(/^#/, '')];
  for (const source of sources) {
    const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(source);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * The invite-acceptance state (org-membership-management, frontend-app):
 * reached by opening the accept URL, token taken from the URL and never an
 * editable field. One password field serves both cases — the invited email has
 * no account (the password becomes its first credential) or already exists
 * (the password proves ownership); the API collapses every unusable-token
 * case into the same error, so this view never claims to know which.
 */
export function AcceptInviteView() {
  const token = invitationTokenFromLocation();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<AcceptInvitationResult | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      setAccepted(await acceptInvitation({ token, password }));
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6" data-testid="invite-missing-token">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle size={24} className="text-destructive" />
          </div>
          <h1 className="text-lg font-semibold">Invitation link invalid</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page requires a valid invitation link from your organization's admin.
          </p>
        </div>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6" data-testid="invite-accepted">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/12">
            <CheckCircle2 size={28} className="text-emerald-600" />
          </div>
          <h1 className="text-lg font-semibold">You're in!</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You joined <span className="font-semibold text-foreground">{accepted.organizationName}</span>{' '}
            as <span className="capitalize">{accepted.role.toLowerCase()}</span>.
            <span data-testid="invite-organization-id" className="hidden">{accepted.organizationId}</span>
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Sign in with <code className="font-mono text-xs">{accepted.email}</code> and the
            password you just set.
          </p>
          <Button
            type="button"
            size="lg"
            className="mt-6 w-full gap-2"
            onClick={() => { window.location.href = '/'; }}
            data-testid="invite-go-signin"
          >
            <LogIn size={16} />
            Go to sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6" data-testid="accept-invite-view">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <span className="text-sm font-bold text-primary-foreground">PR</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Join your organization</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Set a password to accept this invitation. At least 12 characters.
          </p>
        </div>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(next) => setPassword(next)}
            autoComplete="new-password"
            placeholder="At least 12 characters"
            leftIcon={<KeyRound size={15} />}
            minLength={12}
            data-testid="invite-password"
          />
          {error && (
            <div
              className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
              role="alert"
              data-testid="invite-error"
            >
              <AlertTriangle size={15} className="shrink-0 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={submitting || password.length < 12}
            data-testid="invite-accept"
          >
            {submitting ? 'Joining…' : 'Accept invitation'}
          </Button>
        </form>
      </div>
    </div>
  );
}
