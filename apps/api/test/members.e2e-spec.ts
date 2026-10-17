import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { MembershipRole } from '@prisma/client';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { PrismaService } from '@repo/database';
import { TestTenant, registerTenant, TEST_PASSWORD } from './support/auth';

/**
 * E2E for membership management + invitations (org-membership-management).
 * Real HTTP surface over real Postgres: the role gates (member list readable
 * by any member; invitations ADMIN+; role changes/removals OWNER+), the
 * last-owner invariant, single-use opaque acceptance (new account and existing
 * account flows, every dead-token case collapsing to the same 410),
 * duplicate-pending 409s, and the refresh-time enforcement of role changes and
 * removals — a promoted member's next session carries the new role, a removed
 * member's refresh fails.
 */
jest.setTimeout(30_000);

describe('Membership management + invitations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: TestTenant;
  let admin: TestTenant;
  let member: TestTenant;
  let otherOrg: TestTenant;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    owner = await registerTenant(app, 'members-owner');
    otherOrg = await registerTenant(app, 'members-other');
    admin = await materializedMember(MembershipRole.ADMIN);
    member = await materializedMember(MembershipRole.MEMBER);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Registers a material user (who owns a throwaway org), binds an extra
   * membership into the owner's organization, and LOGS IN there — the same
   * session path a real second member takes.
   */
  async function materializedMember(role: MembershipRole): Promise<TestTenant> {
    const material = await registerTenant(app, `members-${role.toLowerCase()}-material`);
    await prisma.membership.create({
      data: {
        userId: material.userId,
        organizationId: owner.organizationId,
        role,
      },
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: material.email,
        password: TEST_PASSWORD,
        organizationId: owner.organizationId,
      });
    expect(login.status).toBe(200);
    return {
      ...material,
      accessToken: login.body.accessToken,
      refreshToken: login.body.refreshToken,
      headers: { Authorization: `Bearer ${login.body.accessToken}` },
    };
  }

  const listMembers = (as: TestTenant) =>
    request(app.getHttpServer()).get('/members').set(as.headers);

  const patchRole = (as: TestTenant, userId: string, role: MembershipRole) =>
    request(app.getHttpServer())
      .patch(`/members/${userId}/role`)
      .set(as.headers)
      .send({ role });

  const removeMember = (as: TestTenant, userId: string) =>
    request(app.getHttpServer()).delete(`/members/${userId}`).set(as.headers);

  const createInvitation = (as: TestTenant, body: object) =>
    request(app.getHttpServer()).post('/invitations').set(as.headers).send(body);

  const listInvitations = (as: TestTenant) =>
    request(app.getHttpServer()).get('/invitations').set(as.headers);

  const revokeInvitation = (as: TestTenant, id: string) =>
    request(app.getHttpServer()).delete(`/invitations/${id}`).set(as.headers);

  const accept = (body: object) =>
    request(app.getHttpServer()).post('/invitations/accept').send(body);

  const myself = (as: TestTenant) =>
    request(app.getHttpServer()).get('/auth/me').set(as.headers);

  const refresh = (refreshToken: string) =>
    request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });

  const uniqueEmail = (prefix: string) =>
    `${prefix}-${randomUUID().slice(0, 8)}@acme.example`;

  describe('member list', () => {
    it('every member reads the roster with roles; foreign members never appear', async () => {
      const res = await listMembers(member);
      expect(res.status).toBe(200);
      const emails = (res.body as Array<{ email: string }>).map((m) => m.email);
      expect(emails).toContain(owner.email);
      expect(emails).toContain(member.email);
      expect(emails).not.toContain(otherOrg.email);
      const ownerRow = (res.body as Array<{ email: string; role: string }>).find(
        (m) => m.email === owner.email,
      );
      expect(ownerRow?.role).toBe('OWNER');
    });
  });

  describe('role changes (OWNER-gated)', () => {
    it('member and admin are 403; the OWNER demotes and re-promotes', async () => {
      expect((await patchRole(member, admin.userId, MembershipRole.MEMBER)).status).toBe(403);
      // An ADMIN is NOT the OWNER: changing a role is an OWNER action.
      expect((await patchRole(admin, member.userId, MembershipRole.ADMIN)).status).toBe(403);

      const demote = await patchRole(owner, admin.userId, MembershipRole.MEMBER);
      expect(demote.status).toBe(200);
      expect(demote.body.role).toBe('MEMBER');
      const promote = await patchRole(owner, admin.userId, MembershipRole.ADMIN);
      expect(promote.status).toBe(200);
      expect(promote.body.role).toBe('ADMIN');
    });

    it('the last OWNER cannot be demoted (409), even by the OWNER', async () => {
      const res = await patchRole(owner, owner.userId, MembershipRole.MEMBER);
      expect(res.status).toBe(409);
      expect((await myself(owner)).body.role).toBe('OWNER');
    });

    it('a foreign userId reads as 404', async () => {
      expect((await patchRole(owner, otherOrg.userId, MembershipRole.MEMBER)).status).toBe(404);
    });

    it('a role change reaches the member at the NEXT refresh (design D5)', async () => {
      const fresh = await materializedMember(MembershipRole.MEMBER);
      expect((await patchRole(owner, fresh.userId, MembershipRole.ADMIN)).status).toBe(200);

      const rotated = await refresh(fresh.refreshToken);
      expect(rotated.status).toBe(200);

      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set({ Authorization: `Bearer ${rotated.body.accessToken}` });
      expect(me.status).toBe(200);
      expect(me.body.role).toBe('ADMIN');
    });
  });

  describe('removal (OWNER-gated)', () => {
    it('member and admin are 403; self-removal is 409', async () => {
      const victim = await materializedMember(MembershipRole.MEMBER);
      expect((await removeMember(member, victim.userId)).status).toBe(403);
      expect((await removeMember(admin, victim.userId)).status).toBe(403);
      expect((await removeMember(owner, owner.userId)).status).toBe(409);
      // Nothing was removed by the rejected calls.
      const roster = await listMembers(member);
      const emails = (roster.body as Array<{ email: string }>).map((m) => m.email);
      expect(emails).toContain(victim.email);
    });

    it('removing a member ends their access at the next refresh', async () => {
      const victim = await materializedMember(MembershipRole.MEMBER);
      expect((await removeMember(owner, victim.userId)).status).toBe(204);

      const roster = await listMembers(member);
      expect(
        (roster.body as Array<{ userId: string }>).find((m) => m.userId === victim.userId),
      ).toBeUndefined();

      expect((await refresh(victim.refreshToken)).status).toBe(401);
    });

    it('an OWNER can remove another OWNER while one OWNER remains; a foreign userId is 404', async () => {
      const second = await materializedMember(MembershipRole.MEMBER);
      expect((await patchRole(owner, second.userId, MembershipRole.OWNER)).status).toBe(200);

      // Two owners exist: removing one is legitimate (the other stays).
      expect((await removeMember(owner, second.userId)).status).toBe(204);
      expect((await refresh(second.refreshToken)).status).toBe(401);
      // The remaining owner cannot be removed by an ADMIN (role gate).
      expect((await removeMember(admin, owner.userId)).status).toBe(403);
      expect((await removeMember(owner, otherOrg.userId)).status).toBe(404);
    });
  });

  describe('invitations (ADMIN-gated)', () => {
    it('a member is 403; an ADMIN and the OWNER can invite', async () => {
      expect(
        (await createInvitation(member, { email: uniqueEmail('blocked'), role: 'MEMBER' }))
          .status,
      ).toBe(403);

      const byAdmin = await createInvitation(admin, {
        email: `Ada.${randomUUID().slice(0, 6)}@Acme.Example`,
        role: 'MEMBER',
      });
      expect(byAdmin.status).toBe(201);
      // Email normalized; token + accept URL returned.
      expect(byAdmin.body.email).toBe((byAdmin.body.email as string).toLowerCase());
      expect(byAdmin.body.acceptToken).toBeDefined();
      expect(byAdmin.body.acceptUrl).toContain(byAdmin.body.acceptToken);

      const byOwner = await createInvitation(owner, {
        email: uniqueEmail('owner-invite'),
        role: 'ADMIN',
      });
      expect(byOwner.status).toBe(201);
    });

    it('OWNER-role invitations and duplicate pendings are rejected', async () => {
      const ownerRole = await createInvitation(admin, {
        email: uniqueEmail('as-owner'),
        role: 'OWNER',
      });
      expect(ownerRole.status).toBe(400);

      const email = uniqueEmail('dup');
      expect((await createInvitation(admin, { email, role: 'MEMBER' })).status).toBe(201);
      expect((await createInvitation(admin, { email, role: 'MEMBER' })).status).toBe(409);
    });

    it('a NEW email: acceptance creates account + membership and login works immediately', async () => {
      const email = uniqueEmail('fresh');
      const invitation = await createInvitation(admin, { email, role: 'MEMBER' });
      expect(invitation.status).toBe(201);

      const accepted = await accept({
        token: invitation.body.acceptToken,
        password: 'another-correct-horse',
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({
        email,
        role: 'MEMBER',
        organizationId: owner.organizationId,
      });

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email,
          password: 'another-correct-horse',
          organizationId: owner.organizationId,
        });
      expect(login.status).toBe(200);
      expect(login.body.role).toBe('MEMBER');
    });

    it('an EXISTING account joins with its password; a wrong one is the opaque 410', async () => {
      const stranger = await registerTenant(app, 'invite-stranger');
      const invitation = await createInvitation(admin, {
        email: stranger.email,
        role: 'ADMIN',
      });
      expect(invitation.status).toBe(201);

      const wrong = await accept({
        token: invitation.body.acceptToken,
        password: 'totally-wrong-password-1',
      });
      expect(wrong.status).toBe(410);
      expect(wrong.body.message).toBe('Invitation is no longer valid');

      const right = await accept({
        token: invitation.body.acceptToken,
        password: stranger.password,
      });
      expect(right.status).toBe(200);
      expect(right.body.role).toBe('ADMIN');
    });

    it('a token cannot be accepted twice; the second attempt is the opaque 410', async () => {
      const invitation = await createInvitation(admin, {
        email: uniqueEmail('once'),
        role: 'MEMBER',
      });
      const first = await accept({
        token: invitation.body.acceptToken,
        password: 'correct-horse-battery',
      });
      expect(first.status).toBe(200);
      const second = await accept({
        token: invitation.body.acceptToken,
        password: 'correct-horse-battery',
      });
      expect(second.status).toBe(410);
    });

    it('unknown and expired tokens are the same opaque 410', async () => {
      expect(
        (await accept({ token: 'nope', password: 'correct-horse-battery' })).status,
      ).toBe(410);

      const invitation = await createInvitation(admin, {
        email: uniqueEmail('expired'),
        role: 'MEMBER',
      });
      await prisma.orgInvitation.update({
        where: { id: invitation.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        (await accept({ token: invitation.body.acceptToken, password: 'correct-horse-battery' }))
          .status,
      ).toBe(410);
    });

    it('a revoked invitation stops being acceptable', async () => {
      const invitation = await createInvitation(admin, {
        email: uniqueEmail('revoke'),
        role: 'MEMBER',
      });
      expect((await revokeInvitation(admin, invitation.body.id)).status).toBe(204);
      expect(
        (await accept({ token: invitation.body.acceptToken, password: 'correct-horse-battery' }))
          .status,
      ).toBe(410);
    });

    it('revoking a non-pending invitation is 409', async () => {
      const invitation = await createInvitation(admin, {
        email: uniqueEmail('accepted'),
        role: 'MEMBER',
      });
      await accept({ token: invitation.body.acceptToken, password: 'correct-horse-battery' });
      expect((await revokeInvitation(admin, invitation.body.id)).status).toBe(409);
    });

    it('the invitation list is ADMIN-gated and never carries tokens', async () => {
      const list = await listInvitations(admin);
      expect(list.status).toBe(200);
      for (const row of list.body as Array<Record<string, unknown>>) {
        expect(row.acceptToken).toBeUndefined();
      }
      expect((await listInvitations(member)).status).toBe(403);
    });
  });
});
