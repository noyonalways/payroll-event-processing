import { useState } from 'react';
import type { FormEvent } from 'react';

import { Input } from '@/components/motion/input';
import { Button } from '@/components/ui/button';

import { forgotPassword, login, register, resetPassword } from '../api/auth';
import { ApiError, NetworkError } from '../api/client';
import type { SessionResponse } from '../lib/types';

export interface AuthViewProps {
  /** Called with the fresh session once the API accepts the credentials. */
  onAuthenticated: (session: SessionResponse) => void;
}

type Mode = 'signin' | 'register' | 'forgot' | 'reset';

/**
 * The signed-out gate: one view with both ways in — sign in to an existing
 * account, or register a new organization with the caller as its owner. The API
 * stays the authority on validation: a structured 400/401/409 is surfaced
 * inline and the typed values are kept, so a bad email or short password does
 * not cost the user their input. A successful call hands the session to the
 * caller (`onAuthenticated`) — persisting it is the app shell's job.
 */
export function AuthView({ onAuthenticated }: AuthViewProps) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Password reset (auth-hardening): the forgot step displays the one-time
  // token for hand-off AND offers the inline hand-off — "reset now" carries
  // the token into the reset step without the user retyping it.
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const registering = mode === 'register';

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setApiError(null);
    setNotice(null);
    if (next === 'forgot') setResetToken(null);
  }

  async function handleForgot(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setApiError(null);
    try {
      // Anti-enumeration: the API answers identically for unknown emails.
      // The ack's token presence is the hand-off, NOT a confirmation the
      // account exists — this view never claims either way.
      const ack = await forgotPassword(email.trim());
      if (ack.token) {
        setResetToken(ack.token);
        setMode('reset');
        setNotice(null);
      } else {
        setNotice(
          'If an account exists for this email, a reset link was issued to its owner. ' +
            'This deployment hands the link out-of-band, so if you know the owner, share it with them.',
        );
      }
    } catch (err) {
      setApiError(
        err instanceof ApiError || err instanceof NetworkError
          ? err.message
          : 'Reset request failed'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReset(event: FormEvent) {
    event.preventDefault();
    if (!resetToken) return;
    setSubmitting(true);
    setApiError(null);
    try {
      await resetPassword(resetToken, password);
      // sessionless by design: the user signs in with the NEW password.
      setResetToken(null);
      setMode('signin');
      setNotice('Password updated. Sign in with your new password.');
    } catch (err) {
      setApiError(
        err instanceof ApiError || err instanceof NetworkError
          ? err.message
          : 'Reset failed'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setApiError(null);
    try {
      const session = registering
        ? await register({
            email: email.trim(),
            password,
            organizationName: organizationName.trim(),
            name: name.trim() || undefined,
          })
        : await login({ email: email.trim(), password });
      onAuthenticated(session);
    } catch (err) {
      setApiError(
        err instanceof ApiError || err instanceof NetworkError
          ? err.message
          : 'Unexpected error while signing in',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-muted/40 p-6 text-foreground dark:bg-background">
      <div className="mx-auto flex min-h-[80vh] max-w-md flex-col justify-center">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Payroll Events
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to submit typed payroll events and watch them progress
            through the processing pipeline in real time.
          </p>
        </header>

        <form
          onSubmit={(event) => {
            if (mode === 'forgot') {
              void handleForgot(event);
            } else if (mode === 'reset') {
              void handleReset(event);
            } else {
              void handleSubmit(event);
            }
          }}
          className="rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
        >
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-full border border-border bg-muted/40 p-1">
            <Button
              type="button"
              variant={mode === 'signin' ? 'default' : 'ghost'}
              size="sm"
              className="rounded-full"
              aria-pressed={mode === 'signin'}
              onClick={() => switchMode('signin')}
            >
              Sign in
            </Button>
            <Button
              type="button"
              variant={registering ? 'default' : 'ghost'}
              size="sm"
              className="rounded-full"
              aria-pressed={registering}
              onClick={() => switchMode('register')}
            >
              Register
            </Button>
          </div>

          {apiError && (
            <p
              role="alert"
              className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {apiError}
            </p>
          )}

          {notice && (
            <p
              className="mb-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground"
              data-testid="auth-notice"
            >
              {notice}
            </p>
          )}

          {mode === 'forgot' ? (
            <>
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                placeholder="owner@acme.example"
                data-testid="forgot-email"
              />
              {notice && (
                <p
                  className="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground"
                  data-testid="forgot-notice"
                >
                  {notice}
                </p>
              )}
              <Button
                type="submit"
                size="lg"
                className="mt-4 w-full shadow-sm"
                disabled={submitting}
                data-testid="auth-submit"
              >
                {submitting ? 'Requesting…' : 'Request reset'}
              </Button>
              <button
                type="button"
                className="mt-3 w-full text-center text-xs text-muted-foreground hover:underline"
                onClick={() => switchMode('signin')}
              >
                Back to sign in
              </button>
            </>
          ) : mode === 'reset' ? (
            <>
              <p
                className="mb-3 select-all rounded-md border border-primary/20 bg-primary/5 px-3 py-2 font-mono text-[11px] break-all"
                data-testid="reset-token-display"
              >
                {resetToken}
              </p>
              <Input
                label="New password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                placeholder="At least 12 characters"
              />
              <Button
                type="submit"
                size="lg"
                className="mt-4 w-full shadow-sm"
                disabled={submitting || password.length < 12}
                data-testid="auth-submit"
              >
                {submitting ? 'Updating…' : 'Set new password'}
              </Button>
            </>
          ) : (
            <>
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                placeholder="owner@acme.example"
              />

              <div className="mt-3">
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete={registering ? 'new-password' : 'current-password'}
                  placeholder={registering ? 'At least 12 characters' : undefined}
                />
              </div>

              {registering && (
                <>
                  <div className="mt-3">
                    <Input
                      label="Your name (optional)"
                      value={name}
                      onChange={setName}
                      autoComplete="name"
                      placeholder="Ada Lovelace"
                    />
                  </div>
                  <div className="mt-3">
                    <Input
                      label="Organization name"
                      value={organizationName}
                      onChange={setOrganizationName}
                      autoComplete="organization"
                      placeholder="Acme Payroll"
                    />
                  </div>
                </>
              )}

              <p className="mt-2 px-1 text-xs text-muted-foreground">
                {registering
                  ? 'Registering creates a new organization with you as its owner — passwords must be at least 12 characters.'
                  : 'Use the account you registered your organization with.'}
              </p>

              {!registering && (
                <button
                  type="button"
                  className="mt-2 text-xs text-muted-foreground hover:underline"
                  onClick={() => switchMode('forgot')}
                  data-testid="forgot-link"
                >
                  Forgot password?
                </button>
              )}

              <Button
                type="submit"
                size="lg"
                className="mt-4 w-full shadow-sm"
                disabled={submitting}
                data-testid="auth-submit"
              >
                {registering
                  ? submitting
                    ? 'Creating organization…'
                    : 'Create organization & sign in'
                  : submitting
                    ? 'Signing in…'
                    : 'Sign in'}
              </Button>
            </>
          )}
        </form>
      </div>
    </main>
  );
}
