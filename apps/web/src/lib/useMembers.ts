import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  NetworkError,
  SessionExpiredError,
  createInvitation as createInvitationApi,
  fetchInvitations,
  fetchMembers,
  removeMember as removeMemberApi,
  revokeInvitation as revokeInvitationApi,
  updateMemberRole as updateMemberRoleApi,
} from '../api/members';
import type {
  Invitation,
  InvitationCreated,
  Member,
  MemberRole,
} from './types';

export const errorOf = (error: unknown): string =>
  error instanceof ApiError || error instanceof NetworkError
    ? error.message
    : error instanceof SessionExpiredError
      ? 'Session expired — sign in again'
      : error instanceof Error
        ? error.message
        : 'Request failed';

/**
 * The members + invitations state behind MembersView
 * (org-membership-management). Server-driven like every list in this app:
 * nothing is invented locally — every mutation re-fetches both lists, so what
 * the API commits is exactly what is shown.
 */
export function useMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        fetchMembers(),
        fetchInvitations().catch(() => [] as Invitation[]),
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
      setListError(null);
    } catch (error) {
      setListError(errorOf(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const withAction = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        await refresh();
        return true;
      } catch (error) {
        setActionError(errorOf(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const changeRole = useCallback(
    (userId: string, role: MemberRole) =>
      withAction(() => updateMemberRoleApi(userId, role)),
    [withAction],
  );

  const remove = useCallback(
    (userId: string) => withAction(() => removeMemberApi(userId)),
    [withAction],
  );

  const revoke = useCallback(
    (invitationId: string) => withAction(() => revokeInvitationApi(invitationId)),
    [withAction],
  );

  /**
   * Creates an invitation. The created record carries the one-time token —
   * it is RETURNED to the caller for hand-off, not stored in component state
   * beyond the copy affordance, and never re-fetched.
   */
  const invite = useCallback(
    async (
      email: string,
      role: 'ADMIN' | 'MEMBER',
    ): Promise<InvitationCreated | null> => {
      setBusy(true);
      setActionError(null);
      try {
        const created = await createInvitationApi({ email, role });
        await refresh();
        return created;
      } catch (error) {
        setActionError(errorOf(error));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return {
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
    clearActionError: () => setActionError(null),
    refresh,
  };
}
