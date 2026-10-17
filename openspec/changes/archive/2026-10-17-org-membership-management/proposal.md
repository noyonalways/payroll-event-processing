# Proposal

## Why

A second user has no way to join an organization: registration always creates a NEW organization
with the caller as OWNER, and the authentication layer explicitly deferred joining to "a later
change" (auth.service doc comment). The tenancy spec already promises multi-membership sessions
and that "removing a membership ends access", but no endpoint manages members. This change is
the way a second user joins an organization — completing the tenancy model's people story
(item 8, "unlock multi-user completion of the tenancy model").

## What Changes

- New **`org_invitations`** records: an ADMIN-or-higher member invites an email address into the
  organization with an initial role (`ADMIN` or `MEMBER` — never OWNER); invitations carry a
  single-use secure token with a bounded validity window and can be revoked while pending.
- **Invite acceptance** (`POST /invitations/accept`, public, token-gated): creates the user
  account when the email is new, or verifies the existing account's password — and creates the
  membership; the response returns the organization and id used for login. No email-delivery
  infrastructure: the invite link/token is returned to the inviting admin and shared out-of-band.
- **Member list** (`GET /members`): members with role and identity, readable by any member.
- **Role changes** (`PATCH /members/:userId/role`): OWNER-only, with last-owner protection.
- **Member removal** (`DELETE /members/:userId`): OWNER-only, cannot remove self or the last
  OWNER — removal ends the removed user's access at their next refresh (already guaranteed by
  the tenancy spec and the refresh path re-reading the membership row).
- **UI**: a Members view (list, invite, revoke, change role, remove) gated by the signed-in
  role, plus an invite-acceptance page reached from the invite link; role enforcement on the new
  endpoints follows the `access-control` matrix (`@Roles(ADMIN)` for invitations, `@Roles(OWNER)`
  for role changes and removal).

## Capabilities

### New Capabilities
- `org-membership`: Managing an organization's people — invitations with single-use tokens,
  member list, OWNER-guarded role changes, member removal with last-owner protection, and
  refresh-time enforcement of membership changes.

### Modified Capabilities
- `frontend-app`: The UI gains a members-management view and an invite-acceptance page served
  from an invitation link.

## Impact

- **DB**: new `org_invitations` table (+ migration); `memberships` table itself is unchanged.
- **API**: new `/members` and `/invitations` endpoints; all tenant-scoped and role-gated; new
  public token-gated acceptance route (the second public route after the auth pair, still
  Swagger-documented).
- **Auth**: login unchanged (it already accepts an optional `organizationId` and rejects
  ambiguous logins); acceptance responses carry the organization id so the invitee can log in
  with it.
- **UI**: new view + api clients; sessions already carry the signed-in role for conditional UI.
- **Roles/tenancy**: builds on `role-enforcement`'s guard and decorator; multi-membership
  login behavior comes from the existing authentication spec.

## Non-goals

- Email delivery of invitations (no SMTP integration; token hand-off is manual/out-of-band in
  this change).
- Organization switching UI, "leave organization" flows, and OWNER-role transfer invitations.
- seat limits, billing, org-wide settings, and renaming organizations.
- Automatic session revocation on removal (tiered enforcement stays: next-refresh, per the
  existing authentication/tenancy specs).
