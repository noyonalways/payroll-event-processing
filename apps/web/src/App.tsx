import { useState } from 'react';
import {
  LayoutDashboard,
  ClipboardList,
  Users,
  Webhook,
  Settings,
  LogOut,
  Wifi,
  WifiOff,
  Menu,
  ChevronRight,
  Plug,
  UserCog,
} from 'lucide-react';

import { logout } from './api/auth';
import { AuthView } from './components/AuthView';
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

type View = 'dashboard' | 'request' | 'requests' | 'people' | 'members' | 'webhooks' | 'provider';

interface NavItem {
  id: View;
  label: string;
  icon: React.ReactNode;
  group?: 'main' | 'settings';
  ownerOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} />, group: 'main' },
  { id: 'requests', label: 'Change Requests', icon: <ClipboardList size={18} />, group: 'main' },
  { id: 'people', label: 'People', icon: <Users size={18} />, group: 'main' },
  { id: 'members', label: 'Members', icon: <UserCog size={18} />, group: 'settings' },
  { id: 'webhooks', label: 'Webhooks', icon: <Webhook size={18} />, group: 'settings' },
  { id: 'provider', label: 'Provider', icon: <Plug size={18} />, group: 'settings', ownerOnly: true },
];

function getInitials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

function PayrollWorkspace({ session }: { session: StoredSession }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const stream = useEventStream({
    enabled: true,
    onNotification: () => setRefreshKey((k) => k + 1),
    onResync: () => setRefreshKey((k) => k + 1),
  });
  const [view, setView] = useState<View>('dashboard');
  const [wizardPrefill, setWizardPrefill] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleSignOut() {
    const { refreshToken } = session;
    clearSession();
    void logout(refreshToken).catch(() => {});
  }

  function navigateTo(v: View) {
    setView(v);
    setSidebarOpen(false);
  }

  const mainItems = NAV_ITEMS.filter(
    (item) => item.group === 'main' && (!item.ownerOnly || session.role === 'OWNER'),
  );
  const settingsItems = NAV_ITEMS.filter(
    (item) => item.group === 'settings' && (!item.ownerOnly || session.role === 'OWNER'),
  );

  const activeLabel = NAV_ITEMS.find((item) => item.id === view)?.label ?? 'Dashboard';

  const sidebarContent = (
    <nav className="flex h-full flex-col" aria-label="Main navigation">
      {/* Brand */}
      <div className="flex items-center gap-3 border-b border-sidebar-border px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-sm">
          <span className="text-xs font-bold text-primary-foreground">PR</span>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-sidebar-foreground">PayrollOS</p>
          <p className="truncate text-xs text-muted-foreground">
            Acting in <span className="font-medium text-foreground">{session.organization.name}</span>
          </p>
        </div>
      </div>

      {/* Live indicator */}
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-2.5">
        {stream.connected ? (
          <Wifi size={13} className="text-emerald-500 shrink-0" />
        ) : (
          <WifiOff size={13} className="text-amber-500 shrink-0" />
        )}
        <span className="text-xs text-muted-foreground">
          {stream.connected ? 'Live updates active' : 'Reconnecting…'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        {/* Main nav group */}
        <ul className="space-y-0.5 px-2">
          {mainItems.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="menuitem"
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => navigateTo(item.id)}
                data-testid={`view-${item.id}`}
                className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                  view === item.id
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                }`}
              >
                <span className="shrink-0">{item.icon}</span>
                {item.label}
                {view === item.id && (
                  <ChevronRight size={14} className="ml-auto opacity-60" />
                )}
              </button>
            </li>
          ))}
        </ul>

        {/* Settings group */}
        {settingsItems.length > 0 && (
          <div className="mt-6 px-2">
            <div className="flex items-center gap-2 px-3 pb-2">
              <Settings size={12} className="text-muted-foreground" />
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Settings
              </p>
            </div>
            <ul className="space-y-0.5">
              {settingsItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    role="menuitem"
                    aria-current={view === item.id ? 'page' : undefined}
                    onClick={() => navigateTo(item.id)}
                    data-testid={`view-${item.id}`}
                    className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                      view === item.id
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                    }`}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    {item.label}
                    {view === item.id && (
                      <ChevronRight size={14} className="ml-auto opacity-60" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* User footer */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {getInitials(session.user.email)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-sidebar-foreground" data-testid="header-user-email" title={session.user.id}>
              {session.user.email}
            </p>
            <p className="text-xs capitalize text-muted-foreground">{session.role.toLowerCase()}</p>
          </div>
          <button
            type="button"
            title="Sign out"
            aria-label="Sign out"
            onClick={handleSignOut}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            data-testid="sign-out-button"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <aside
        className="hidden w-[240px] shrink-0 border-r border-sidebar-border bg-sidebar lg:flex lg:flex-col"
        data-testid="sidebar"
      >
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          />
          <aside className="absolute left-0 top-0 h-full w-[240px] border-r border-sidebar-border bg-sidebar shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main content area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <span className="text-xs font-bold text-primary-foreground">PR</span>
          </div>
          <span className="text-sm font-semibold">{activeLabel}</span>
        </header>

        {/* Desktop page header + content */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-8">
            {/* Desktop breadcrumb / page title */}
            <div className="mb-6 hidden items-center gap-2 lg:flex">
              <span className="text-xs text-muted-foreground">PayrollOS</span>
              <ChevronRight size={12} className="text-muted-foreground" />
              <span className="text-xs font-medium text-foreground">{activeLabel}</span>
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
              <MembersView />
            ) : view === 'webhooks' ? (
              <WebhooksView />
            ) : (
              <ProviderConfigView />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function App() {
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
