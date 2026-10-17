import { useState } from 'react';
import type { FormEvent } from 'react';

import { Input } from '@/components/motion/input';
import { Button } from '@/components/ui/button';

import { resetPassword } from '../api/auth';
import { ApiError, NetworkError } from '../api/client';

/**
 * Extracts the password-reset token from a reset link — canonical path
 * (`/reset/<token>`) or hash form (`#/reset/<token>`).
 */
export function resetTokenFromLocation(
  pathname: string = window.location.pathname,
  hash: string = window.location.hash,
): string | null {
  for (const source of [pathname, hash.replace(/^#/, '')]) {
    const match = /\/reset\/([A-Za-z0-9_-]+)/.exec(source);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * The standalone password-reset state (auth-hardening UI) reached by opening
 * the reset link handed out by the account owner. One password field (the
 * strength policy is the API's — 12+ characters); completion routes back to
 * sign-in with a confirmation, and every dead token is one opaque error.
 */
export function ResetPasswordView() {
  const token = resetTokenFromLocation();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof NetworkError
          ? err.message
          : 'Reset failed'
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <main className="min-h-screen bg-muted/40 p-6 text-foreground dark:bg-background">
        <div className="mx-auto max-w-md pt-24" data-testid="reset-missing-token">
          <h1 className="text-xl font-semibold tracking-tight">Reset link invalid</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page needs a password-reset link. Ask the account owner to
            request a new one.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 p-6 text-foreground dark:bg-background">
      <div className="mx-auto max-w-md pt-24" data-testid="reset-password-view">
        <h1 className="text-xl font-semibold tracking-tight">Set a new password</h1>
        {done ? (
          <div className="mt-4 space-y-3" data-testid="reset-done">
            <p className="text-sm text-muted-foreground">
              Password updated, and every active session for the account was
              signed out. Go back to the app and sign in with the new password.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                window.location.href = '/';
              }}
              data-testid="reset-go-signin"
            >
              Go to sign in
            </Button>
          </div>
        ) : (
          <form
            className="mt-4 space-y-3 rounded-xl border border-border bg-card p-5"
            onSubmit={handleSubmit}
          >
            <Input
              label="New password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              placeholder="At least 12 characters"
            />
            {error && (
              <p className="text-sm text-destructive" role="alert" data-testid="reset-error">
                {error}
              </p>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={submitting || password.length < 12}
              data-testid="reset-submit"
            >
              {submitting ? 'Updating…' : 'Set new password'}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
