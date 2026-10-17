# org-membership Specification

## Purpose

Give organizations a managed membership lifecycle — invite people in, see who is in, change
roles, remove people — so a user can join an existing organization and role changes reach the
session model without new mechanisms.

## Requirements

### Requirement: Administrators can invite an email into the organization

The system SHALL expose `POST /invitations` requiring a membership role of ADMIN or higher. The
body SHALL consist of `email` (valid address, normalized case-insensitively) and `role` (ADMIN or
MEMBER; inviting as OWNER SHALL be rejected with HTTP `400`). A pending invitation for the same
email in the organization SHALL be rejected with HTTP `409`. A success SHALL create a
`PENDING` invitation with a cryptographically random single-use token (stored so the raw token
is never recoverable from the database), an invited-by reference, and an expiry bounded by
configuration (default 7 days), and SHALL return HTTP `201` with the invitation representation
including the one-time accept token or accept URL. Accepted invitation records SHALL NOT be
redeemable again, and no email-delivery system is implied — the token hand-off to the invitee is
out-of-band.

#### Scenario: Admin invites a new member
- **WHEN** a client with role ADMIN or higher POSTs `{ "email": "ada@acme.example", "role": "MEMBER" }` to `/invitations`
- **THEN** the response SHALL be HTTP `201` with the invitation record and a usable accept token, and no membership SHALL exist yet

#### Scenario: OWNER-role invitations are rejected
- **WHEN** a client posts an invitation with `role` `OWNER`
- **THEN** the response SHALL be HTTP `400` and no invitation SHALL be created

#### Scenario: Duplicate pending invitation is a conflict
- **WHEN** an organization already has a `PENDING` invitation for an email and another is posted for it
- **THEN** the response SHALL be HTTP `409` and no new invitation SHALL be created

#### Scenario: Invitations are tenant-scoped
- **WHEN** a client with role ADMIN in organization A lists invitations or accepts-relevant state
- **THEN** only organization A's invitations SHALL be visible, and organization B's rows SHALL never be readable or revocable through them
### Requirement: An invitation can be accepted exactly once within its validity

The system SHALL expose `POST /invitations/accept` as a public route gated solely by possession
of the invitation token. When the invited email has no user account, the request SHALL also
carry the initial password (meeting the same strength policy as registration) and the system
SHALL create the account. When an account with the invited email exists, the request SHALL carry
that account's password and SHALL reject a wrong password without revealing account state.
On success the system SHALL create the membership with the invitation's role, mark the
invitation `ACCEPTED`, and return HTTP `200` with the organization id and name; a subsequent
login in that organization SHALL succeed like any member's. An expired, revoked, already-accepted,
or unknown token SHALL be rejected with HTTP `410`, `409`, or `404`-equivalent structured error
without leaking which.

#### Scenario: New invitee creates an account and joins
- **WHEN** the invitation token is presented with a valid new password and the invited email has no account
- **THEN** the account SHALL be created with that email, the membership SHALL exist with the invited role, and the response SHALL identify the organization to log into

#### Scenario: Existing account proves ownership to join
- **WHEN** the invitation token is presented with the correct password of the account holding the invited email
- **THEN** the membership SHALL be created and the invitation marked accepted

#### Scenario: Existing account with wrong password is rejected
- **WHEN** the invitation token is presented with a password that does not match the existing account
- **THEN** the response SHALL be an error and no membership SHALL be created

#### Scenario: A token cannot be reused
- **WHEN** the same invitation token is presented twice
- **THEN** exactly one acceptance SHALL succeed and the second SHALL be rejected

#### Scenario: Rejected invitations never appear unauthenticated
- **WHEN** an invalid or expired token is presented
- **THEN** the response SHALL be an opaque structured error and SHALL NOT distinguish expired, revoked, or unknown tokens
### Requirement: Members can be listed, and roles changed only by the OWNER

The system SHALL expose `GET /members` to any authenticated member of the organization, returning
each member's user identity, email, role, and joined-at timestamp. The system SHALL expose
`PATCH /members/{userId}/role` requiring a membership role of OWNER. A role change SHALL NOT be
allowed to leave the organization without at least one OWNER (demoting or changing the last
OWNER SHALL be rejected with HTTP `409`). An unknown member of another organization SHALL be
reported as `404`, and requests from below the minimum role SHALL be rejected with HTTP `403`.
Role changes SHALL take effect for existing sessions through the existing refresh path — the
role SHALL be re-read from the membership at refresh time and conveyed in the new access token.

#### Scenario: Member list is readable by every member
- **WHEN** a member reads the member list
- **THEN** the response SHALL be HTTP `200` with the organization's members and roles, and no other organization's members SHALL appear

#### Scenario: Only the OWNER changes roles
- **WHEN** a caller with role ADMIN or MEMBER attempts a role change
- **THEN** the response SHALL be HTTP `403` and the membership SHALL be unchanged

#### Scenario: The last OWNER cannot be demoted
- **WHEN** the OWNER attempts to change the only OWNER membership to a lower role
- **THEN** the response SHALL be HTTP `409` and the role SHALL be unchanged

#### Scenario: Role change reaches the next session
- **WHEN** a member's role is changed while they hold a session
- **THEN** their refreshed session SHALL convey the new role and enforced authorization SHALL follow it
### Requirement: Membership removal ends access

The system SHALL expose `DELETE /members/{userId}` requiring a membership role of OWNER. A
member SHALL NOT remove themselves, and the last OWNER SHALL NOT be removable; each SHALL be
rejected with HTTP `409`. Removal SHALL delete the membership row; thereafter the removed user
SHALL NOT be able to refresh into the organization (existing behavior), SHALL disappear from the
member list, and SHALL re-join only through a new invitation. A user of another organization
SHALL be reported as `404`.

#### Scenario: Owner removes a member
- **WHEN** the OWNER deletes another member's membership
- **THEN** the response SHALL be HTTP `204`, the row SHALL be deleted, and a later refresh by that user SHALL fail for the organization

#### Scenario: Removing oneself is rejected
- **WHEN** the OWNER (or any member) attempts to remove their own membership through the API
- **THEN** the response SHALL be HTTP `409` and the membership SHALL remain

#### Scenario: The last OWNER cannot be removed
- **WHEN** only one OWNER remains and a client attempts to remove them
- **THEN** the response SHALL be HTTP `409` and the membership SHALL remain
### Requirement: Pending invitations can be listed and revoked

The system SHALL expose `GET /invitations` and `DELETE /invitations/{id}` requiring a membership
role of ADMIN or higher. The list SHALL show the organization's invitations with email, role,
status, invited-by, and expiry. Revocation SHALL mark a `PENDING` invitation so its token is no
longer acceptable; revoking a non-pending invitation SHALL be rejected with HTTP `409`. An
invitation of another organization SHALL be reported as `404`.

#### Scenario: Admin revokes a pending invitation
- **WHEN** a client with role ADMIN or higher deletes a pending invitation
- **THEN** the invitation SHALL no longer be acceptable and its token SHALL be treated as revoked

#### Scenario: Revoked invitation is not acceptable
- **WHEN** the token of a revoked invitation is presented for acceptance
- **THEN** the response SHALL be an opaque structured error and no membership SHALL be created
