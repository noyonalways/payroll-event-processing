import { useState } from 'react';
import type { FormEvent } from 'react';

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
      <div className="mx-auto max-w-md" data-testid="invite-missing-token">
        <h1 className="text-xl font-semibold tracking-tight">Invitation link invalid</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page needs an invitation link from your organization's admin.
        </p>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="mx-auto max-w-md space-y-3" data-testid="invite-accepted">
        <h1 className="text-xl font-semibold tracking-tight">You're in</h1>
        <p className="text-sm text-muted-foreground">
          You joined <span className="font-medium text-foreground">{accepted.organizationName}</span>{' '}
          as {accepted.role.toLowerCase()}.
        </p>
        <p className="text-sm text-muted-foreground">
          Go back to the app and sign in with{' '}
          <span className="font-mono text-xs">{accepted.email}</span> and the password you just
          chose. Organization id for sign-in:{' '}
          <span className="font-mono text-xs" data-testid="invite-organization-id">
            {accepted.organizationId}
          </span>
        </p>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            window.location.href = '/';
          }}
          data-testid="invite-go-signin"
        >
          Go to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md" data-testid="accept-invite-view">
      <h1 className="text-xl font-semibold tracking-tight">Join your organization</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose a password (at least 12 characters). If you already have an account for this
        email, enter its password — the invitation will be linked to it.
      </p>
      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(next) => setPassword(next)}
          autoComplete="new-password"
          minLength={12}
          data-testid="invite-password"
        />
        {error && (
          <p className="text-sm text-destructive" role="alert" data-testid="invite-error">
            {error}
          </p>
        )}
        <Button type="submit" size="sm" disabled={submitting || password.length < 12} data-testid="invite-accept">
          {submitting ? 'Joining…' : 'Accept invitation'}
        </Button>
      </form>
    </div>
  );
}
