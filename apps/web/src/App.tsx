import { useState } from 'react';
import type React from 'react';
import {
  LayoutDashboard,
  ClipboardList,
  Users,
  Webhook,
  Wifi,
  WifiOff,
  Menu,
  UserCog,
  Plug,
  LogOut,
  ChevronRight,
  Settings,
} from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@repo/ui/breadcrumb';

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
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={17} />, group: 'main' },
  { id: 'requests', label: 'Change Requests', icon: <ClipboardList size={17} />, group: 'main' },
  { id: 'people', label: 'People', icon: <Users size={17} />, group: 'main' },
  { id: 'members', label: 'Members', icon: <UserCog size={17} />, group: 'settings' },
  { id: 'webhooks', label: 'Webhooks', icon: <Webhook size={17} />, group: 'settings' },
  { id: 'provider', label: 'Provider Config', icon: <Plug size={17} />, group: 'settings', ownerOnly: true },
];

function getInitials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

/** Inline SVG logo mark */
function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lgMark" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#lgMark)" />
      {/* Stylised "P" with circular bowl */}
      <circle cx="14" cy="13" r="5" stroke="white" strokeWidth="2.5" fill="none" />
      <line x1="9" y1="13" x2="9" y2="24" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="14" y1="18" x2="14" y2="24" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="22" cy="22" r="2.5" fill="white" opacity="0.7" />
    </svg>
  );
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
    <nav className="flex h-full flex-col sidebar-brand-bg" aria-label="Main navigation">
      {/* ── Brand header ───────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-sidebar-border">
        <LogoMark size={34} />
        <div className="min-w-0">
          <p className="text-sm font-bold text-white tracking-tight">PayrollOS</p>
          <p className="truncate text-[11px] text-sidebar-foreground/60 mt-0.5">
            Acting in <span className="font-medium text-white/90">{session.organization.name}</span>
          </p>
        </div>
      </div>

      {/* ── Live connection status ──────────────────────── */}
      <div className="mx-3 my-2.5 flex items-center gap-2 rounded-lg border border-sidebar-border/60 bg-white/[0.04] px-3 py-2">
        {stream.connected ? (
          <>
            <span className="live-dot relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <span className="text-[11px] font-medium text-emerald-400">Live</span>
            <span className="text-[11px] text-sidebar-foreground/40 ml-auto">Real-time active</span>
          </>
        ) : (
          <>
            <WifiOff size={12} className="text-amber-400 shrink-0" />
            <span className="text-[11px] font-medium text-amber-400">Reconnecting…</span>
          </>
        )}
      </div>

      {/* ── Nav items ──────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto py-2">
        {/* Main group */}
        <div className="px-2 mb-1">
          <p className="px-3 pt-2 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/35">
            Workspace
          </p>
          <ul className="space-y-0.5">
            {mainItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="menuitem"
                  aria-current={view === item.id ? 'page' : undefined}
                  onClick={() => navigateTo(item.id)}
                  data-testid={`view-${item.id}`}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                    view === item.id
                      ? 'nav-active'
                      : 'text-sidebar-foreground/65 hover:bg-white/[0.06] hover:text-sidebar-foreground'
                  }`}
                >
                  <span className={`shrink-0 ${view === item.id ? 'text-primary' : ''}`}>
                    {item.icon}
                  </span>
                  {item.label}
                  {view === item.id && (
                    <ChevronRight size={13} className="ml-auto opacity-50" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Settings group */}
        {settingsItems.length > 0 && (
          <div className="px-2 mt-4">
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-1.5">
              <Settings size={10} className="text-sidebar-foreground/35" />
              <p className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/35">
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
                    className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                      view === item.id
                        ? 'nav-active'
                        : 'text-sidebar-foreground/65 hover:bg-white/[0.06] hover:text-sidebar-foreground'
                    }`}
                  >
                    <span className={`shrink-0 ${view === item.id ? 'text-primary' : ''}`}>
                      {item.icon}
                    </span>
                    {item.label}
                    {view === item.id && (
                      <ChevronRight size={13} className="ml-auto opacity-50" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── User footer ────────────────────────────────── */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-white/[0.05] transition-colors">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-cyan-400 text-xs font-bold text-white shadow-sm">
            {getInitials(session.user.email)}
          </div>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-xs font-medium text-sidebar-foreground/90"
              data-testid="header-user-email"
              title={session.user.id}
            >
              {session.user.email}
            </p>
            <p className="text-[10px] capitalize text-sidebar-foreground/40 mt-0.5">
              {session.role.toLowerCase()} · PayrollOS
            </p>
          </div>
          <button
            type="button"
            title="Sign out"
            aria-label="Sign out"
            onClick={handleSignOut}
            className="rounded-lg p-1.5 text-sidebar-foreground/40 transition-colors hover:bg-red-500/15 hover:text-red-400"
            data-testid="sign-out-button"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <aside
        className="hidden w-[252px] shrink-0 border-r border-sidebar-border lg:flex lg:flex-col"
        data-testid="sidebar"
      >
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          />
          <aside className="absolute left-0 top-0 h-full w-[252px] border-r border-sidebar-border shadow-2xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main content area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3.5 lg:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted transition-colors"
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>
          <LogoMark size={26} />
          <span className="text-sm font-semibold text-foreground">{activeLabel}</span>
        </header>

        {/* Desktop top strip with breadcrumb */}
        <div className="hidden lg:flex items-center gap-3 border-b border-border bg-card/60 backdrop-blur-sm px-8 py-3.5">
          <Breadcrumb data-testid="app-breadcrumb">
            <BreadcrumbList>
              <BreadcrumbItem key="root">
                <BreadcrumbLink
                  href="#"
                  onClick={(e: React.MouseEvent) => {
                    e.preventDefault();
                    navigateTo('dashboard');
                  }}
                  className="font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  PayrollOS
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem key={view}>
                <BreadcrumbPage className="font-semibold">{activeLabel}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {/* Connection pill on right */}
          <div className="ml-auto flex items-center gap-1.5">
            {stream.connected ? (
              <Wifi size={12} className="text-emerald-500" />
            ) : (
              <WifiOff size={12} className="text-amber-500" />
            )}
            <span className="text-xs text-muted-foreground">
              {stream.connected ? 'Live' : 'Reconnecting'}
            </span>
          </div>
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-8 page-in">
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
