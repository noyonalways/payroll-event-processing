import { useState } from 'react';

import { logout } from './api/auth';
import { AuthView } from './components/AuthView';
import { Button } from './components/ui/button';
import { MembersView } from './components/MembersView';
import { AcceptInviteView, invitationTokenFromLocation } from './components/AcceptInviteView';
import { ResetPasswordView, resetTokenFromLocation } from './components/ResetPasswordView';
import { WebhooksView } from './components/WebhooksView';
import { ProviderConfigView } from './components/ProviderConfigView';
import { DashboardView } from './components/DashboardView';
import { RequestChangeView } from './components/RequestChangeView';
import { RequestsView } from './components/RequestsView';
import { PeopleView } from './components/PeopleView';
import { useEventStream } from './lib/useEventStream';
import { clearSession, setSession } from './lib/session';
import type { StoredSession } from './lib/session';
import { useSession } from './lib/useSession';

/**
 * The authenticated workspace, organized around the real user journey
 * (frontend-app rework): a Dashboard that answers "what needs my attention",
 * a plain-language change-request wizard, the full request register, and a
 * People view showing each person's current pay details. Integration admin
 * (members / webhooks / provider) sits in a Settings group. Live lifecycle
 * updates still arrive over the event-status-stream, with the same
 * server-owned, nothing-local data rules as before: sign-out leaves nothing
 * behind and reloads simply re-fetch.
 */
function PayrollWorkspace({ session }: { session: StoredSession }) {
  // The SSE lifecycle stream stays connected for the workspace indicator;
  // the new views re-fetch server-side data on their own cadence/callbacks.
  const stream = useEventStream({ enabled: true });
  const [view, setView] = useState<
    'dashboard' | 'request' | 'requests' | 'people' | 'members' | 'webhooks' | 'provider'
  >('dashboard');
  const [refreshKey, setRefreshKey] = useState(0);
  const [wizardPrefill, setWizardPrefill] = useState<string | null>(null);

  function handleSignOut() {
    // Revoke the refresh token server-side (logout is idempotent, always 204)
    // and drop the session. The data itself is server-owned, so nothing else
    // needs clearing — the next session fetches ITS organization only.
    const { refreshToken } = session;
    clearSession();
    void logout(refreshToken).catch(() => {
      // Best effort — local sign-out already happened.
    });
  }

  return (
    <main className="min-h-screen bg-muted/40 p-6 text-foreground dark:bg-background">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Payroll Events
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Request payroll changes for your people and watch every step —
              submission, processing, and the applied result — in real time.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span
              className="text-xs text-muted-foreground"
              title={session.user.id}
              data-testid="header-user-email"
            >
              Signed in as{' '}
              <span className="font-medium text-foreground">{session.user.email}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
              acting in{' '}
              <span className="font-semibold text-foreground">
                {session.organization.name}
              </span>{' '}
              · {session.role}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
              <span
                className={`h-1.5 w-1.5 rounded-full ${stream.streamConnected ? 'bg-emerald-500' : 'bg-amber-500'}`}
                aria-hidden
              />
              {stream.streamConnected ? 'live' : 'reconnecting…'}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        <div
          role="tablist"
          aria-label="Views"
          className="mb-5 flex flex-wrap items-center gap-2"
          data-testid="view-switch"
        >
          <Button
            type="button"
            variant={view === 'dashboard' ? 'default' : 'outline'}
            size="sm"
            role="tab"
            aria-selected={view === 'dashboard'}
            onClick={() => setView('dashboard')}
            data-testid="view-dashboard"
          >
            Dashboard
          </Button>
          <Button
            type="button"
            variant={view === 'requests' ? 'default' : 'outline'}
            size="sm"
            role="tab"
            aria-selected={view === 'requests'}
            onClick={() => setView('requests')}
            data-testid="view-requests"
          >
            Change requests
          </Button>
          <Button
            type="button"
            variant={view === 'people' ? 'default' : 'outline'}
            size="sm"
            role="tab"
            aria-selected={view === 'people'}
            onClick={() => setView('people')}
            data-testid="view-people"
          >
            People
          </Button>
          <span className="mx-2 h-6 w-px bg-border" aria-hidden data-testid="settings-divider" />
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Settings
          </span>
          <Button
            type="button"
            variant={view === 'members' ? 'default' : 'outline'}
            size="sm"
            role="tab"
            aria-selected={view === 'members'}
            onClick={() => setView('members')}
            data-testid="view-members"
          >
            Members
          </Button>
          <Button
            type="button"
            variant={view === 'webhooks' ? 'default' : 'outline'}
            size="sm"
            role="tab"
            aria-selected={view === 'webhooks'}
            onClick={() => setView('webhooks')}
            data-testid="view-webhooks"
          >
            Webhooks
          </Button>
          {session.role === 'OWNER' && (
            <Button
              type="button"
              variant={view === 'provider' ? 'default' : 'outline'}
              size="sm"
              role="tab"
              aria-selected={view === 'provider'}
              onClick={() => setView('provider')}
              data-testid="view-provider"
            >
              Provider
            </Button>
          )}
        </div>

        {view === 'dashboard' ? (
          <DashboardView
            refreshKey={refreshKey}
            onRequestChange={() => setView('request')}
            onOpenRequests={() => setView('requests')}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
        ) : view === 'request' ? (
          <RequestChangeView
            prefillEmployeeNumber={wizardPrefill}
            onSubmitted={() => {
              setRefreshKey((k) => k + 1);
              setWizardPrefill(null);
              setView('requests');
            }}
          />
        ) : view === 'requests' ? (
          <RequestsView refreshKey={refreshKey} />
        ) : view === 'people' ? (
          <PeopleView
            refreshKey={refreshKey}
            onRequestChange={(employeeNumber) => {
              setWizardPrefill(employeeNumber);
              setView('request');
            }}
          />
        ) : view === 'members' ? (
          <div className="mx-auto max-w-4xl">
            <MembersView />
          </div>
        ) : view === 'webhooks' ? (
          <div className="mx-auto max-w-5xl">
            <WebhooksView />
          </div>
        ) : (
          <ProviderConfigView />
        )}
      </div>
    </main>
  );
}

function App() {
  // Hooks first (rules-of-hooks); the invite/reset branches render before ANY
  // session gating — invitees and resetters have no session yet.
  const session = useSession();
  const inviteToken = invitationTokenFromLocation();
  const resetToken = resetTokenFromLocation();
  if (inviteToken) {
    return <AcceptInviteView />;
  }
  if (resetToken) {
    return <ResetPasswordView />;
  }
  if (!session) {
    return <AuthView onAuthenticated={setSession} />;
  }
  return <PayrollWorkspace session={session} />;
}

export default App;
