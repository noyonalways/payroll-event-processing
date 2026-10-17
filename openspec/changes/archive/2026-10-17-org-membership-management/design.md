# Design

## Context

The auth layer already supports multi-org login: `resolveMembership`
(`packages/core/src/auth/auth.service.ts`) takes an optional `organizationId` (single-membership
accounts omit it; ambiguous logins are rejected), and `refresh` re-reads the membership row so
role changes and removals reach existing sessions at next refresh — the access-control spec's
token carries only `sub`/`org`/`role`/`type`. `role-enforcement`'s `@Roles()` decorator and
hierarchy are the gate mechanism. Registration (`POST /auth/register`) always creates a new
organization with an OWNER membership; the service doc comment explicitly defers "join an
existing organization" to this change. Refresh tokens are stored as SHA-256 hashes of
high-entropy random values (`token.service.ts`), which is the storage precedent for invitation
tokens. Frontend: `AuthView` (register/login), `useSession`/`session.ts` hold the signed-in role.

## Goals / Non-Goals

**Goals:**

- Join-by-invitation without new session machinery: acceptance creates membership rows only.
- One guard pattern (`@Roles`) for every management endpoint; parity with the baseline matrix.
- Token discipline identical to refresh tokens (random value shown once, hash stored, opaque
  lookup).

**Non-Goals:**

- Email delivery, org switching UI, leave-org, OWNER invites, auto-revocation of live access
  tokens (next-refresh enforcement, already spec'd).

## Decisions

### D1 — New `org_invitations` table (Prisma migration in `packages/database/prisma/migrations/`)

Columns: `id` (uuid pk), `organization_id` (FK → organizations), `email` (text, normalized
lowercase), `role` (MembershipRole enum, DTO-restricted to ADMIN|MEMBER), `token_hash`
(text, unique — SHA-256 of the high-entropy raw token, mirroring `refresh_tokens.token_hash`),
`status` (enum `PENDING`, `ACCEPTED`, `REVOKED`, `EXPIRED`), `invited_by` (FK → users),
`expires_at`, `accepted_at` (null), `accepted_by_user_id` (null, FK → users), `created_at`,
`updated_at`. Indexes: `@@unique([organizationId, email])` partial... Prisma partial-unique for
PENDING rows is expressed in the service instead: a `UNIQUE (organization_id, email)` full
constraint would block re-inviting after a revoked/accepted invite, so the service enforces
"no second PENDING per (organization, email)" inside a transaction (checked-then-create with the
existing 409-mapping convention, `P2002` treated as conflict for safety), plus
`@@index([organizationId, status])` for list views. `token_hash` unique index gives O(1) opaque
acceptance lookups.

### D2 — Endpoints and roles (new `packages/core/src/members/members.module.ts` with controller, service, DTOs)

- `POST /invitations`, `GET /invitations`, `DELETE /invitations/:id` — `@Roles(ADMIN)`.
- `PATCH /members/:userId/role`, `DELETE /members/:userId` — `@Roles(OWNER)`.
- `GET /members` — any authenticated member (default, no annotation).
- `POST /invitations/accept` — `@Public()`; the second public write route in the API.
All mutations return conventional codes (400 validation, 403 role, 404 cross-org/unknown,
409 state conflicts, 410 expired-token acceptance), matching the access-control spec's
authentication-before-tenancy-before-role ordering.

### D3 — Acceptance is token-possession plus account-proof, one endpoint

`POST /invitations/accept { token, password }`:
1. Hash the presented token, look up by `token_hash`; unknown/expired/revoked/accepted →
   structured opaque error (membership state never revealed).
2. Load the invited email. An existing user: verify `password` against the stored digest via the
   existing `PasswordService` (mismatch → generic error, same anti-enumeration posture as login).
   No user: create one (email normalized lowercase, name = email local-part, hashed password).
3. Create the membership with the invitation's role, mark the invitation ACCEPTED
   (`accepted_at`, `accepted_by_user_id`), commit atomically; concurrent double-acceptance is
   defeated by `updateMany WHERE status = 'PENDING'` guarded transition (the codebase's
   established optimistic-guard pattern) — the loser aborts without creating a membership.
4. Respond with `organizationId`/`organizationName`; login then completes the session
   (login POST /auth/login already accepts the optional organizationId).
Raw tokens are 32 random bytes base64url (same length as refresh tokens), shown only in the
create/accept-URL response.

### D4 — Last-owner invariant is checked transactionally, not by convention

Role changes and removals run inside a transaction: guard transition first
(`updateMany`/`deleteMany` WHERE role/status as appropriate), then re-count OWNER memberships in
the organization; if the count drops to zero, throw and roll back (409). Self-removal is a
pre-check (`actor.userId === targetUserId → 409`). These are the only consistency-critical
writes here; everything else is single-row CRUD. Reliability concept: guarded transitions +
transactional invariants (same discipline as the claim's status guards).

### D5 — Enforcement reach for existing sessions

No new revocation mechanism: the tenancy spec's "removing a membership ends access" and
`auth.service.refresh`'s membership re-read already make removal/role-changes effective at the
next refresh, and short access tokens (authentication spec) bound the staleness window — stated
publicly in the member-management UI copy. Attempts to act with a stale access token after role
change are re-authorized at request time by `@Roles` against the token's (old) role — the
accepted staleness window is the remaining access-token TTL.

### D6 — Frontend (`apps/web/src/`)

- `api/members.ts` + `api/invitations.ts` (typed clients on the existing authorized `fetch`
  client in `api/client.ts`), `lib/useMembers.ts` hook.
- `components/MembersView.tsx` — list with role badges; invite dialog (email + role); copyable
  accept-URL for hand-off; role select and remove buttons rendered only when
  `session.role === 'OWNER'` (invite for `ADMIN|OWNER`), consistent with the access-control
  matrix; 403s surface through the existing error path.
- `components/AcceptInviteView.tsx` — reads `token` from the URL, adapts its description when the
  invitee has an existing account (single password flow; label explains both cases), on success
  shows the joined organization and routes to sign-in (AuthView) carrying the organizationId in
  state.
- Router wiring in `App.tsx` (accept route is unauthenticated); Vitest + Testing Library specs
  per the existing `*.test.tsx` convention.

## Risks / Trade-offs

- [Invitation token leak before acceptance ⇒ third party joins as the invited email] →
  single-use + hashed storage + 7-day expiry + revocation; existing accounts additionally
  require the account password, so a leaked token alone cannot attach a foreign membership to a
  live account. New-email abuse only creates a fresh account for an email the attacker already
  holds a token for — no existing data is reachable.
- [Stale access token keeps elevated role until TTL expires] → accepted; the codebase already
  accepts this window tenancy-wide, and the auth-hardening queued change owns further tightening.
- [Re-invite loop after removal] → allowed deliberately; membership unique constraint per
  (userId, organizationId) is a Prisma-level guarantee; removal then new invitation creates no
  conflict.

## Migration Plan

Additive: one migration creating `org_invitations`; new module + routes; new UI view. No
existing table or route changes, so deploy-after-migrate is backwards-compatible (orgs with no
invitations see nothing). Apply AFTER `role-enforcement` (uses its decorator/guard) and after
`employee-directory` + `realtime-status` deltas settle (frontend-app target spec must exist in
main specs — archive first, same note as role-enforcement). Rollback: disable the module; the
new table is inert.

## Open Questions

None — invite email-sending stays out by scope, token TTL default (7 days) is configuration, not
behaviour.
