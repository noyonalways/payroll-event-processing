import { useState } from 'react';

import { logout } from './api/auth';
import { AuthView } from './components/AuthView';
import { Button } from './components/ui/button';
import { EventDetail } from './components/EventDetail';
import { EventFilters } from './components/EventFilters';
import { EventList } from './components/EventList';
import { SubmitForm } from './components/SubmitForm';
import { clearSession, setSession } from './lib/session';
import type { StoredSession } from './lib/session';
import { useEventHistory } from './lib/useEventHistory';
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
 * Two-pane demo UI over the organization's history: submit typed payroll
 * events and browse the SERVER-driven event history (`GET /events`) with
 * combinable filters and load-more paging. Non-terminal rows keep polling
 * `GET /events/{id}` so badges and attempt counts move without a manual
 * refresh; the detail panel shows the processing result and the failure trail.
 * There is no client-side list persistence — every view is what the server
 * holds for the signed-in organization, so sign-out leaves nothing behind and
 * reloads simply re-fetch. Requests go through the authenticated client, so
 * the header names the organization the session is acting in.
 */
function PayrollWorkspace({ session }: { session: StoredSession }) {
  const history = useEventHistory();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Derive the selection; when the selected row leaves the current view
  // (filters changed, page re-fetched), the detail panel falls back to the
  // placeholder.
  const selected =
    history.rows.find((row) => row.id === selectedId) ?? null;

  function handleSignOut() {
    // Revoke the refresh token server-side (logout is idempotent, always 204)
    // and drop the session. The history itself is server-owned, so nothing
    // else needs clearing — the next session fetches ITS organization only.
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
              Submit typed payroll events and browse the organization's
              processing history as it moves through the pipeline in real time.
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
                live polling · {history.rows.length} shown
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
            <SubmitForm onSubmitted={() => void history.refresh()} />

            <EventFilters
              filters={history.filters}
              onChange={history.setFilter}
              onClear={history.clearFilters}
            />

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-semibold tracking-tight">
                  Event history
                </h2>
              </div>
              {history.loadError && (
                <p
                  role="alert"
                  className="mb-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {history.loadError}
                </p>
              )}
              {history.loading ? (
                <p
                  className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
                  data-testid="event-history-loading"
                >
                  Loading history…
                </p>
              ) : (
                <EventList
                  rows={history.rows}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              )}
              {history.hasMore && !history.loading && (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => void history.loadMore()}
                    disabled={history.loadingMore}
                    data-testid="load-more"
                  >
                    {history.loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
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
                Select an event to inspect its lifecycle, processing result, and
                failure trail.
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

export default App;
