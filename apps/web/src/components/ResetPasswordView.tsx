import { useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, AlertTriangle, CheckCircle2, LogIn } from 'lucide-react';

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
 * Standalone password-reset view reached by opening the reset link. One
 * password field (minimum 12 characters); completion routes back to sign-in.
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
      <div className="flex min-h-screen items-center justify-center bg-background p-6" data-testid="reset-missing-token">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle size={24} className="text-destructive" />
          </div>
          <h1 className="text-lg font-semibold">Reset link invalid</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page requires a password-reset link. Ask the account owner to request a new one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6" data-testid="reset-password-view">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <span className="text-sm font-bold text-primary-foreground">PR</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Set a new password</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Choose a strong password — at least 12 characters.
          </p>
        </div>

        {done ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center" data-testid="reset-done">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/12">
              <CheckCircle2 size={28} className="text-emerald-600" />
            </div>
            <h2 className="text-lg font-semibold">Password updated</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Every active session was signed out. Sign in with your new password.
            </p>
            <Button
              type="button"
              size="lg"
              className="mt-6 w-full gap-2"
              onClick={() => { window.location.href = '/'; }}
              data-testid="reset-go-signin"
            >
              <LogIn size={16} />
              Go to sign in
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <Input
              label="New password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              placeholder="At least 12 characters"
              leftIcon={<KeyRound size={15} />}
            />
            {error && (
              <div
                className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
                role="alert"
                data-testid="reset-error"
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
              data-testid="reset-submit"
            >
              {submitting ? 'Updating…' : 'Set new password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
