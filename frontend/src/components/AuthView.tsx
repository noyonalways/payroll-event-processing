import { useState } from 'react';
import type { FormEvent } from 'react';

import { Input } from '@/components/motion/input';
import { Button } from '@/components/ui/button';

import { login, register } from '../api/auth';
import { ApiError, NetworkError } from '../api/client';
import type { SessionResponse } from '../lib/types';

export interface AuthViewProps {
  /** Called with the fresh session once the API accepts the credentials. */
  onAuthenticated: (session: SessionResponse) => void;
}

type Mode = 'signin' | 'register';

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

  const registering = mode === 'register';

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setApiError(null);
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
          onSubmit={handleSubmit}
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
        </form>
      </div>
    </main>
  );
}
