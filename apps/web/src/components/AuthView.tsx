import { useState } from 'react';
import type { FormEvent } from 'react';
import { LogIn, Building2, KeyRound, Mail, User, AlertCircle, CheckCircle2, ArrowRight, Shield, Zap, Globe } from 'lucide-react';

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

/** Inline SVG logo for auth page */
function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lgAuth" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#lgAuth)" />
      <circle cx="14" cy="13" r="5" stroke="white" strokeWidth="2.5" fill="none" />
      <line x1="9" y1="13" x2="9" y2="24" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="14" y1="18" x2="14" y2="24" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="22" cy="22" r="2.5" fill="white" opacity="0.7" />
    </svg>
  );
}

const FEATURES = [
  { icon: <Zap size={16} />, label: 'Real-time lifecycle tracking via SSE' },
  { icon: <Shield size={16} />, label: 'HMAC-signed webhook deliveries' },
  { icon: <Globe size={16} />, label: 'Automatic retries with DLQ fallback' },
  { icon: <CheckCircle2 size={16} />, label: 'Role-based access control' },
];

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
          : 'Welcome back';

  const formSubtitle =
    mode === 'forgot'
      ? "Enter your email and we'll issue a reset link."
      : mode === 'reset'
        ? 'Choose a strong password — at least 12 characters.'
        : registering
          ? 'Start processing payroll events in minutes.'
          : 'Sign in to your PayrollOS workspace.';

  return (
    <div className="flex min-h-screen bg-background">
      {/* ── Left branding panel ─────────────────────────────── */}
      <div
        className="hidden lg:flex lg:w-1/2 xl:w-[46%] lg:flex-col lg:justify-between relative overflow-hidden"
        style={{
          background: 'linear-gradient(160deg, #0a1628 0%, #0d2438 35%, #061a1a 70%, #040e0e 100%)',
        }}
      >
        {/* Background brand illustration */}
        <div
          className="absolute inset-0 bg-cover bg-center opacity-30"
          style={{ backgroundImage: 'url(/auth-bg.jpg)' }}
          aria-hidden="true"
        />

        {/* Gradient overlays for depth */}
        <div className="absolute inset-0 bg-gradient-to-br from-teal-900/40 via-transparent to-violet-900/30" />
        <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-black/60 to-transparent" />

        {/* Glowing orbs */}
        <div className="absolute top-32 left-24 h-64 w-64 rounded-full bg-teal-500/10 blur-3xl" />
        <div className="absolute bottom-32 right-16 h-48 w-48 rounded-full bg-violet-600/10 blur-3xl" />

        {/* Content */}
        <div className="relative z-10 flex flex-col h-full px-12 py-14 justify-between">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <LogoMark size={38} />
            <span className="text-xl font-bold text-white tracking-tight">PayrollOS</span>
          </div>

          {/* Main copy */}
          <div className="space-y-8">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-300">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
                Payroll event processing platform
              </div>
              <h1 className="text-4xl font-bold leading-tight tracking-tight text-white">
                Payroll events,<br />
                <span className="gradient-text">end to end.</span>
              </h1>
              <p className="text-base leading-relaxed text-white/60 max-w-xs">
                Submit salary changes, bank updates, department moves, and more — track each one through the processing pipeline in real time.
              </p>
            </div>

            {/* Feature list */}
            <ul className="space-y-3">
              {FEATURES.map((f) => (
                <li key={f.label} className="flex items-center gap-3 text-sm text-white/75">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-400 border border-teal-500/20">
                    {f.icon}
                  </span>
                  {f.label}
                </li>
              ))}
            </ul>
          </div>

          {/* Bottom footer */}
          <p className="text-xs text-white/30">
            © {new Date().getFullYear()} PayrollOS. All changes are audited and immutable.
          </p>
        </div>
      </div>

      {/* ── Right form panel ────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 bg-background">
        {/* Mobile logo */}
        <div className="mb-8 flex items-center gap-2.5 lg:hidden">
          <LogoMark size={32} />
          <span className="text-lg font-bold tracking-tight">PayrollOS</span>
        </div>

        <div className="w-full max-w-[420px]">
          {/* Form header */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">{formTitle}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{formSubtitle}</p>
          </div>

          {/* Mode switcher — only for signin / register */}
          {(mode === 'signin' || mode === 'register') && (
            <div className="mb-6 flex rounded-xl border border-border bg-muted/40 p-1">
              <button
                type="button"
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-all duration-200 ${
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
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-all duration-200 ${
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
              className="mb-5 flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/8 px-4 py-3.5"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">{apiError}</p>
            </div>
          )}

          {/* Notice banner */}
          {notice && !apiError && (
            <div
              className="mb-5 flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/8 px-4 py-3.5"
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
                  className="rounded-xl border border-primary/25 bg-primary/8 px-4 py-3.5 text-sm text-foreground"
                  data-testid="forgot-notice"
                >
                  {notice}
                </div>
              )}
              <Button
                type="submit"
                size="lg"
                className="w-full gap-2"
                disabled={submitting || !email.trim()}
                data-testid="auth-submit"
              >
                {submitting ? 'Sending…' : (
                  <><span>Send reset link</span><ArrowRight size={15} /></>
                )}
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
                <div className="rounded-xl border border-border bg-muted/50 px-4 py-3.5">
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
                className="w-full gap-2"
                disabled={submitting}
                data-testid="auth-submit"
              >
                {registering
                  ? submitting
                    ? 'Creating organization…'
                    : <><span>Create organization &amp; sign in</span><ArrowRight size={15} /></>
                  : submitting
                    ? 'Signing in…'
                    : <><span>Sign in</span><ArrowRight size={15} /></>
                }
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
