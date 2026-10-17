import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, NetworkError } from '../api/members';
import { Button } from './ui/button';
import { Input } from '@/components/motion/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select';
import { errorOf, useMembers } from '../lib/useMembers';
import { getSession } from '../lib/session';
import type { Member, MemberRole } from '../lib/types';

const joinedLabel = (iso: string) => iso.slice(0, 10);

const roleLabel = (role: string): MemberRole | string =>
  ({ OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' })[role] ?? role;

/**
 * The members view (org-membership-management, frontend-app): the roster with
 * roles for EVERY signed-in member; the invite form appears for ADMIN+ and the
 * per-row role select + remove for the OWNER only — the same thresholds the
 * API gates, so a member never sees controls that would 403 (and if one is
 * invoked anyway, the structured 403 surfaces through the error line).
 *
 * The invite response's one-time accept URL is displayed for out-of-band
 * hand-off; it is never persisted beyond the copy the admin does.
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

  const formFilled = useMemo(() => email.trim() !== '', [email]);

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (!formFilled || inviting) return;
    setInviting(true);
    setHandoffUrl(null);
    const created = await invite(email.trim(), inviteRole);
    if (created) {
      setEmail('');
      // Base the hand-off on the SPA origin; the token is the secret part.
      setHandoffUrl(`${window.location.origin}${created.acceptUrl}`);
    }
    setInviting(false);
  }

  return (
    <section className="space-y-6" data-testid="members-view">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Members</h2>
        <p className="text-sm text-muted-foreground">
          Everyone with access to this organization.
          {isOwner
            ? ' Only you can change roles and remove members.'
            : canInvite
              ? ' You can invite new members.'
              : ''}
        </p>
      </div>

      {canInvite && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={handleInvite}
          data-testid="invite-form"
        >
          <div className="flex-1 min-w-52">
            <Input
              label="Invite by email"
              type="email"
              value={email}
              onChange={(next) => setEmail(next)}
              placeholder="person@company.example"
              autoComplete="off"
              data-testid="invite-email"
            />
          </div>
          <div>
            <label htmlFor="invite-role" className="mb-1 block text-sm font-medium">
              Role
            </label>
            <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as 'ADMIN' | 'MEMBER')}>
              <SelectTrigger id="invite-role" className="w-32" data-testid="invite-role">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" size="sm" disabled={!formFilled || busy || inviting} data-testid="invite-submit">
            {inviting ? 'Inviting…' : 'Invite'}
          </Button>
        </form>
      )}

      {handoffUrl && (
        <div
          className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm"
          data-testid="invite-handoff"
        >
          Invitation created. Share this one-time accept link (also valid as{' '}
          <code>POST /invitations/accept</code> with the trailing token):
          <div className="mt-1 select-all font-mono text-xs break-all">
            {handoffUrl}
          </div>
        </div>
      )}

      {actionError && (
        <div
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="members-action-error"
        >
          <span>{actionError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={clearActionError}
          >
            dismiss
          </Button>
        </div>
      )}

      {listError && (
        <p className="text-sm text-destructive" role="alert" data-testid="members-list-error">
          {listError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="members-loading">
          Loading…
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border" data-testid="member-table">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Joined</th>
                {isOwner && <th className="px-3 py-2" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {members.map((member: Member) => (
                <tr key={member.userId} className="border-t" data-testid="member-row">
                  <td className="px-3 py-2">
                    <div className="font-medium">{member.name ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">{member.email}</div>
                  </td>
                  <td className="px-3 py-2">
                    {isOwner && member.role !== 'OWNER' ? (
                      <Select
                        value={member.role}
                        onValueChange={(v) => void changeRole(member.userId, v as MemberRole)}
                        data-testid={`role-select-${member.email}`}
                      >
                        <SelectTrigger className="w-28" data-testid={`role-select-${member.userId}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="MEMBER">Member</SelectItem>
                          <SelectItem value="ADMIN">Admin</SelectItem>
                          <SelectItem value="OWNER">Owner</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span>{roleLabel(member.role)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {joinedLabel(member.joinedAt)}
                  </td>
                  {isOwner && (
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={busy}
                        onClick={() => void remove(member.userId)}
                        data-testid={`remove-${member.userId}`}
                      >
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {members.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                    No members found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {canInvite && invitations.length > 0 && (
        <div data-testid="invitation-list">
          <h3 className="mb-2 text-sm font-semibold">Pending invitations</h3>
          <ul className="space-y-1 text-sm">
            {invitations
              .filter((invitation) => invitation.status === 'PENDING')
              .map((invitation) => (
                <li key={invitation.id} className="flex items-center justify-between gap-2">
                  <span>
                    {invitation.email} · {roleLabel(invitation.role)} · expires{' '}
                    {joinedLabel(invitation.expiresAt)}
                  </span>
                  {isOwner || role === 'ADMIN' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={busy}
                      onClick={() => void revoke(invitation.id)}
                      data-testid={`revoke-${invitation.id}`}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </li>
              ))}
            {invitations.every((invitation) => invitation.status !== 'PENDING') && (
              <li className="text-muted-foreground">No pending invitations.</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
