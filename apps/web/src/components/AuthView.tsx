import { useState } from 'react';
import type { FormEvent } from 'react';
import { LogIn, Building2, KeyRound, Mail, User, AlertCircle, CheckCircle2 } from 'lucide-react';

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
 * Production auth gate: split-panel design with a branded left panel and a
 * clean right-panel form. Supports sign-in, organization registration,
 * forgot-password, and inline password-reset flows. The API is the authority
 * on validation; structured errors surface inline without losing user input.
 */
export function AuthView({ onAuthenticated }: AuthViewProps) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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
      const ack = await forgotPassword(email.trim());
      if (ack.token) {
        setResetToken(ack.token);
        setMode('reset');
        setNotice(null);
      } else {
        setNotice(
          'If an account exists for this email, a reset link was issued. This deployment hands the link out-of-band.',
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

  const formTitle =
    mode === 'forgot'
      ? 'Reset your password'
      : mode === 'reset'
        ? 'Set a new password'
        : registering
          ? 'Create your organization'
          : 'Sign in to your workspace';

  const formSubtitle =
    mode === 'forgot'
      ? 'Enter your email and we\'ll issue a reset link.'
      : mode === 'reset'
        ? 'Choose a strong password — at least 12 characters.'
        : registering
          ? 'Start processing payroll events in minutes.'
          : 'Track every payroll change from submission to outcome.';

  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Left branding panel ─────────────────────────────── */}
      <div className="hidden lg:flex lg:w-[480px] lg:flex-col lg:justify-between bg-primary px-12 py-16 text-primary-foreground">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 shadow-sm backdrop-blur-sm">
            <span className="text-sm font-bold">PR</span>
          </div>
          <span className="text-xl font-semibold">PayrollOS</span>
        </div>

        {/* Main copy */}
        <div className="space-y-6">
          <h1 className="text-4xl font-bold leading-tight tracking-tight">
            Payroll events,<br />end to end.
          </h1>
          <p className="text-base leading-relaxed text-primary-foreground/80">
            Submit salary changes, bank account updates, department moves, and address
            changes — and watch each one move through the processing pipeline in real time.
          </p>

          {/* Feature list */}
          <ul className="space-y-3">
            {[
              'Real-time lifecycle tracking via SSE',
              'Automatic retries with DLQ fallback',
              'HMAC-signed webhook deliveries',
              'Role-based access control',
            ].map((feature) => (
              <li key={feature} className="flex items-center gap-3 text-sm text-primary-foreground/90">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20">
                  <CheckCircle2 size={12} />
                </span>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        {/* Bottom quote */}
        <p className="text-xs text-primary-foreground/50">
          © {new Date().getFullYear()} PayrollOS. All changes are audited and immutable.
        </p>
      </div>

      {/* ── Right form panel ────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        {/* Mobile logo */}
        <div className="mb-8 flex items-center gap-2 lg:hidden">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <span className="text-xs font-bold text-primary-foreground">PR</span>
          </div>
          <span className="text-lg font-semibold">PayrollOS</span>
        </div>

        <div className="w-full max-w-sm">
          {/* Form header */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">{formTitle}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{formSubtitle}</p>
          </div>

          {/* Mode switcher — only for signin / register */}
          {(mode === 'signin' || mode === 'register') && (
            <div className="mb-6 flex rounded-xl border border-border bg-muted/50 p-1">
              <button
                type="button"
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-all duration-200 ${
                  mode === 'signin'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                aria-pressed={mode === 'signin'}
                onClick={() => switchMode('signin')}
              >
                <LogIn size={14} />
                Sign in
              </button>
              <button
                type="button"
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-all duration-200 ${
                  registering
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                aria-pressed={registering}
                onClick={() => switchMode('register')}
              >
                <Building2 size={14} />
                Register
              </button>
            </div>
          )}

          {/* Error banner */}
          {apiError && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">{apiError}</p>
            </div>
          )}

          {/* Notice banner */}
          {notice && !apiError && (
            <div
              className="mb-5 flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/8 px-4 py-3"
              data-testid="auth-notice"
            >
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-primary" />
              <p className="text-sm text-foreground">{notice}</p>
            </div>
          )}

          {/* ── Forgot password form ── */}
          {mode === 'forgot' && (
            <form onSubmit={(e) => void handleForgot(e)} className="space-y-4">
              <Input
                label="Email address"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                placeholder="you@company.com"
                leftIcon={<Mail size={16} />}
                data-testid="forgot-email"
              />
              {notice && (
                <div
                  className="rounded-xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-foreground"
                  data-testid="forgot-notice"
                >
                  {notice}
                </div>
              )}
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={submitting || !email.trim()}
                data-testid="auth-submit"
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </Button>
              <button
                type="button"
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => switchMode('signin')}
              >
                ← Back to sign in
              </button>
            </form>
          )}

          {/* ── Reset password form ── */}
          {mode === 'reset' && (
            <form onSubmit={(e) => void handleReset(e)} className="space-y-4">
              {resetToken && (
                <div className="rounded-xl border border-border bg-muted/50 px-4 py-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Reset token</p>
                  <p
                    data-testid="reset-token-display"
                    className="select-all break-all font-mono text-[11px] text-foreground"
                  >
                    {resetToken}
                  </p>
                </div>
              )}
              <Input
                label="New password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                placeholder="At least 12 characters"
                leftIcon={<KeyRound size={16} />}
              />
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={submitting || password.length < 12}
                data-testid="auth-submit"
              >
                {submitting ? 'Updating…' : 'Set new password'}
              </Button>
            </form>
          )}

          {/* ── Sign in / Register form ── */}
          {(mode === 'signin' || mode === 'register') && (
            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              <Input
                label="Email address"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                placeholder="you@company.com"
                leftIcon={<Mail size={16} />}
              />

              <Input
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete={registering ? 'new-password' : 'current-password'}
                placeholder={registering ? 'At least 12 characters' : '••••••••'}
                leftIcon={<KeyRound size={16} />}
              />

              {registering && (
                <>
                  <Input
                    label="Your name (optional)"
                    value={name}
                    onChange={setName}
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    leftIcon={<User size={16} />}
                  />
                  <Input
                    label="Organization name"
                    value={organizationName}
                    onChange={setOrganizationName}
                    autoComplete="organization"
                    placeholder="Acme Payroll"
                    leftIcon={<Building2 size={16} />}
                  />
                  <p className="text-xs text-muted-foreground">
                    Registering creates a new organization with you as its Owner.
                    Passwords must be at least 12 characters.
                  </p>
                </>
              )}

              {!registering && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    onClick={() => switchMode('forgot')}
                    data-testid="forgot-link"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                className="w-full"
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
          )}
        </div>
      </div>
    </div>
  );
}
