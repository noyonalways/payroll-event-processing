import { useState } from 'react';

import { logout } from './api/auth';
import { AuthView } from './components/AuthView';
import { Button } from './components/ui/button';
import { EventDetail } from './components/EventDetail';
import { EventList } from './components/EventList';
import { SubmitForm } from './components/SubmitForm';
import { clearSession, setSession } from './lib/session';
import type { StoredSession } from './lib/session';
import { clearTrackedEvents } from './lib/storage';
import { useEventTracker } from './lib/useEventTracker';
import { useSession } from './lib/useSession';

/**
 * Session gate: without a session the app shows the sign-in / registration
 * view; with one it shows the authenticated event workspace. The client layer
 * clears the session when a refresh is rejected, so a forced sign-out lands
 * back on the sign-in view through the same subscription.
 */
function App() {
  const session = useSession();
  if (!session) {
    return <AuthView onAuthenticated={setSession} />;
  }
  return <PayrollWorkspace session={session} />;
}

/**
 * Two-pane demo UI: submit typed payroll events and watch them progress
 * `received → queued → processing → success | failed` through live polling in
 * the tracked list, with a detail panel showing the processing result and the
 * failure trail (retries, errorType, failedReason). Select a row to inspect it.
 * Requests go through the authenticated client, so the header names the
 * organization the session is acting in.
 */
function PayrollWorkspace({ session }: { session: StoredSession }) {
  const { entries, recordSubmission, clearList } = useEventTracker();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Derive the selection; when the selected event leaves the tracked list
  // (e.g. "Clear list"), the detail panel falls back to the placeholder.
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  function handleSignOut() {
    // Revoke the refresh token server-side (logout is idempotent, always 204)
    // and drop every piece of local state together. Clearing first returns the
    // UI to sign-in immediately; the captured token still reaches the endpoint
    // even though the store is already empty.
    const { refreshToken } = session;
    clearTrackedEvents();
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
              Submit typed payroll events and watch them progress through the
              processing pipeline in real time.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
                acting in{' '}
                <span className="font-semibold text-foreground">
                  {session.organization.name}
                </span>{' '}
                · {session.role}
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                live polling · {entries.length} tracked
              </span>
              <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
                Sign out
              </Button>
            </div>
            <p className="text-xs text-muted-foreground" title={session.user.id}>
              Signed in as{' '}
              <span className="font-medium text-foreground">
                {session.user.email}
              </span>
            </p>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-6">
            <SubmitForm onSubmitted={recordSubmission} />

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-semibold tracking-tight">
                  Tracked events
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearList}
                  disabled={entries.length === 0}
                >
                  Clear list
                </Button>
              </div>
              <EventList
                entries={entries}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold tracking-tight">
              Event detail
            </h2>
            {selected ? (
              <EventDetail entry={selected} />
            ) : (
              <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                Select a tracked event to inspect its lifecycle, processing
                result, and failure trail.
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

export default App;
