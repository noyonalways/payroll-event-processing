import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  UserPlus,
  Mail,
  AlertTriangle,
  CheckCircle2,
  X,
  Copy,
  Shield,
  ShieldCheck,
  Crown,
  Trash2,
} from 'lucide-react';

import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select';
import { useMembers } from '../lib/useMembers';
import { getSession } from '../lib/session';
import type { Member, MemberRole } from '../lib/types';

const joinedLabel = (iso: string) => iso.slice(0, 10);

const roleLabel = (role: string): string =>
  ({ OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' })[role] ?? role;

function getInitials(name: string | null | undefined, email: string): string {
  if (name) return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

const ROLE_CHIP: Record<string, { icon: React.ReactNode; classes: string }> = {
  OWNER: {
    icon: <Crown size={11} />,
    classes: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  ADMIN: {
    icon: <ShieldCheck size={11} />,
    classes: 'border-primary/30 bg-primary/10 text-primary',
  },
  MEMBER: {
    icon: <Shield size={11} />,
    classes: 'border-border bg-muted text-muted-foreground',
  },
};

/**
 * The members view: the roster with roles, invite form, pending invitations,
 * and per-row role management. Invite link is shown exactly once after creation.
 * Controls gate on role thresholds matching the API, so nothing visible will 403.
 */
export function MembersView() {
  const {
    members,
    invitations,
    loading,
    listError,
    actionError,
    busy,
    changeRole,
    remove,
    revoke,
    invite,
    clearActionError,
  } = useMembers();

  const session = getSession();
  const role = session?.role ?? 'MEMBER';
  const canInvite = role === 'OWNER' || role === 'ADMIN';
  const isOwner = role === 'OWNER';

  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER');
  const [inviting, setInviting] = useState(false);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const formFilled = useMemo(() => email.trim() !== '', [email]);

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (!formFilled || inviting) return;
    setInviting(true);
    setHandoffUrl(null);
    const created = await invite(email.trim(), inviteRole);
    if (created) {
      setEmail('');
      setHandoffUrl(`${window.location.origin}${created.acceptUrl}`);
    }
    setInviting(false);
  }

  function copyUrl() {
    if (!handoffUrl) return;
    void navigator.clipboard.writeText(handoffUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const pendingInvitations = invitations.filter((inv) => inv.status === 'PENDING');

  return (
    <section className="space-y-8" data-testid="members-view">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone with access to this organization.{' '}
          {isOwner
            ? 'As Owner, you can change roles and remove members.'
            : canInvite
              ? 'You can invite new members.'
              : ''}
        </p>
      </div>

      {/* Invite form */}
      {canInvite && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <UserPlus size={15} className="text-muted-foreground" />
            Invite a member
          </h2>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={handleInvite}
            data-testid="invite-form"
          >
            <div className="min-w-52 flex-1">
              <Input
                label="Email address"
                type="email"
                value={email}
                onChange={(next) => setEmail(next)}
                placeholder="person@company.example"
                autoComplete="off"
                leftIcon={<Mail size={15} />}
                data-testid="invite-email"
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="mb-1.5 block text-sm font-medium">
                Role
              </label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as 'ADMIN' | 'MEMBER')}>
                <SelectTrigger className="w-32" data-testid="invite-role">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={!formFilled || busy || inviting}
              data-testid="invite-submit"
              className="gap-2"
            >
              <UserPlus size={14} />
              {inviting ? 'Inviting…' : 'Send invite'}
            </Button>
          </form>

          {/* One-time invite URL */}
          {handoffUrl && (
            <div
              className="mt-4 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3"
              data-testid="invite-handoff"
            >
              <div className="mb-2 flex items-center gap-2">
                <CheckCircle2 size={14} className="text-primary" />
                <p className="text-sm font-semibold text-foreground">Invitation created</p>
              </div>
              <p className="mb-2 text-xs text-muted-foreground">
                Share this one-time accept link with the invitee. It expires when used.
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <code className="flex-1 select-all break-all font-mono text-[11px] text-foreground">
                  {handoffUrl}
                </code>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Copy link"
                >
                  {copied ? (
                    <CheckCircle2 size={14} className="text-emerald-600" />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error banner */}
      {actionError && (
        <div
          className="flex items-start justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="members-action-error"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{actionError}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
            onClick={clearActionError}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {listError && (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3"
          role="alert"
          data-testid="members-list-error"
        >
          <AlertTriangle size={15} className="shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{listError}</p>
        </div>
      )}

      {/* Members list */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
              <div className="skeleton h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-4 w-36 rounded" />
                <div className="skeleton h-3 w-48 rounded" />
              </div>
              <div className="skeleton h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card" data-testid="member-table">
          {members.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-muted-foreground">No members found.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {members.map((member: Member) => {
                const chip = ROLE_CHIP[member.role] ?? ROLE_CHIP.MEMBER;
                return (
                  <li
                    key={member.userId}
                    className="flex flex-wrap items-center gap-4 px-5 py-4"
                    data-testid="member-row"
                  >
                    {/* Avatar */}
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                      {getInitials(member.name, member.email)}
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{member.name ?? '—'}</span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${chip.classes}`}
                        >
                          {chip.icon}
                          {roleLabel(member.role)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{member.email}</p>
                    </div>

                    {/* Joined */}
                    <div className="hidden text-xs text-muted-foreground sm:block">
                      Joined {joinedLabel(member.joinedAt)}
                    </div>

                    {/* Owner-only actions */}
                    {isOwner && member.role !== 'OWNER' && (
                      <div className="flex items-center gap-2">
                        <Select
                          value={member.role}
                          onValueChange={(v) => void changeRole(member.userId, v as MemberRole)}
                          data-testid={`role-select-${member.email}`}
                        >
                          <SelectTrigger
                            className="h-8 w-28 text-xs"
                            data-testid={`role-select-${member.userId}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="MEMBER">Member</SelectItem>
                            <SelectItem value="ADMIN">Admin</SelectItem>
                            <SelectItem value="OWNER">Owner</SelectItem>
                          </SelectContent>
                        </Select>
                        <button
                          type="button"
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          disabled={busy}
                          onClick={() => void remove(member.userId)}
                          data-testid={`remove-${member.userId}`}
                          title={`Remove ${member.name ?? member.email}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Pending invitations */}
      {canInvite && pendingInvitations.length > 0 && (
        <div data-testid="invitation-list">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Mail size={14} className="text-muted-foreground" />
            Pending invitations
            <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {pendingInvitations.length}
            </span>
          </h2>
          <ul className="space-y-2">
            {pendingInvitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{invitation.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {roleLabel(invitation.role)} · expires {joinedLabel(invitation.expiresAt)}
                  </p>
                </div>
                {(isOwner || role === 'ADMIN') && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy}
                    onClick={() => void revoke(invitation.id)}
                    data-testid={`revoke-${invitation.id}`}
                  >
                    <X size={12} />
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
