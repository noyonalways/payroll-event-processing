# Tasks

## 1. Schema and invitation domain

- [x] 1.1 Add the `org_invitations` model + `OrgInvitationStatus` enum to `packages/database/prisma/schema.prisma` per design D1 (token_hash unique, indexes), generate client and migration — verify `pnpm prisma migrate dev` applies and types compile.
- [x] 1.2 Implement invitation creation/token issuance in `packages/core/src/members/` (service + DTOs): secure token generation and SHA-256 hashing mirroring `token.service.ts`, PENDING-per-(org,email) conflict mapping, expiry default 7d — unit-test token uniqueness, conflict, and expiry computation.

## 2. Management API

- [x] 2.1 Implement `GET /members`, `PATCH /members/:userId/role`, and `DELETE /members/:userId` with `@Roles(OWNER)` on the two mutations (design D2, last-owner + self-removal guards transactional per D4) — unit-test the last-owner rollback and self-removal guard; e2e coverage in `test/members.e2e-spec.ts` for role-gating (member 403, admin 403 on OWNER routes, owner succeeds), cross-org 404, and last-owner 409.
- [x] 2.2 Implement `POST /invitations` / `GET /invitations` / `DELETE /invitations/:id` with `@Roles(ADMIN)`, revoke-as-guarded-transition — e2e: duplicate-pending 409, OWNER-role body 400, revoke then accept rejected; verify tenant scoping on listing.
- [x] 2.3 Implement `POST /invitations/accept` (`@Public`, design D3): opaque token errors, existing-account password verification via `PasswordService`, new-account creation, guarded `status = 'PENDING'` acceptance claim, atomic membership creation — e2e cover all spec scenarios (new invitee, existing correct/wrong password, double accept, expired/revoked).

## 3. Session and enforcement behavior

- [x] 3.1 Prove the refresh-time enforcement path end-to-end (no new code expected): e2e scenario where a member's role is changed then their refresh yields the new role, and a removed member's refresh is rejected — verify existing `auth` e2e suites stay green. **Note: reliability-adjacent — refresh re-reads membership; do not alter that path.**

## 4. UI

- [x] 4.1 Add `api/members.ts`, `api/invitations.ts`, and `lib/useMembers.ts` on the authorized client — Vitest unit coverage including 403/404/409 mapping.
- [x] 4.2 Build `components/MembersView.tsx` (list, invite dialog with copyable accept URL, role select + remove rendered per session role per design D6) and `components/AcceptInviteView.tsx` (token from URL, password form, success → sign-in hand-off), wire routing in `App.tsx` — Testing Library specs: member sees read-only view, admin sees invite, owner sees role/remove; accept view submits and displays the joined organization; 403 path surfaces the error.
- [x] 4.3 Frontend build + test pass (`pnpm --filter web test` / `lint` / `build`) — verify no regression in existing view specs.

## 5. Docs and CI

- [x] 5.1 Swagger-documented routes (roles, error codes, public accept route explicit), README member-management section — verify `/api-docs` shows the matrix.
- [x] 5.2 Full CI parity (`pnpm lint`, backend unit + e2e, frontend vitest) — verify green including new suites.
