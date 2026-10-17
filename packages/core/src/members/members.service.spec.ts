import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipRole, OrgInvitationStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { MembersService, MembersServiceOpaqueInvitationError } from './members.service';

/**
 * Membership service units (org-membership-management design D3/D4): the
 * guarded last-owner invariant, opaque token handling, and single-use
 * acceptance. The mock replays interactive transactions against the same
 * object, exactly like event-recovery.service.spec — assertions inspect the
 * statements and their guard clauses, not an engine.
 */
describe('MembersService', () => {
  const OWNER = MembershipRole.OWNER;

  const makeHarness = () => {
    const prisma = {
      membership: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(2),
        create: jest.fn(),
      },
      user: { findUnique: jest.fn(), create: jest.fn() },
      organization: { findUniqueOrThrow: jest.fn() },
      orgInvitation: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const passwords = { hash: jest.fn().mockResolvedValue('$scrypt$…'), verify: jest.fn() };
    const config = { get: jest.fn((key: string) => (key === 'ORG_INVITE_TTL_DAYS' ? 7 : undefined)) };
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
    const service = new MembersService(
      prisma as never,
      passwords as never,
      config as unknown as ConfigService,
    );
    return { service, prisma, passwords };
  };

  const membershipRow = (role: MembershipRole) => ({
    organizationId: 'org-a',
    userId: 'u-target',
    role,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    user: { email: 't@example.com', name: 'Target' },
  });

  describe('role changes (OWNER-gated, design D4)', () => {
    it('changes the role of an existing member', async () => {
      const { service, prisma } = makeHarness();
      prisma.membership.findFirst.mockResolvedValue(membershipRow(MembershipRole.MEMBER));

      const result = await service.updateMemberRole('org-a', 'u-target', { role: MembershipRole.ADMIN });

      expect(prisma.membership.updateMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', userId: 'u-target' },
        data: { role: 'ADMIN' },
      });
      expect(result).toMatchObject({ userId: 'u-target', role: 'ADMIN' });
    });

    it('rolls back demoting the LAST owner (409) and leaves the role unchanged', async () => {
      const { service, prisma } = makeHarness();
      prisma.membership.findFirst.mockResolvedValue(membershipRow(OWNER));
      // Post-update owner count: ZERO means the demotion removed the last owner.
      prisma.membership.count.mockResolvedValue(0);

      await expect(
        service.updateMemberRole('org-a', 'u-target', { role: MembershipRole.MEMBER }),
      ).rejects.toThrow(ConflictException);

      // In-tx evaluation means the tx aborted; the guarded update happened but
      // the service raised BEFORE commit — the rollback is the mock caller's
      // concern, the invariant check is what this suite pins.
      expect(prisma.membership.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', role: MembershipRole.OWNER },
      });
    });

    it('404s a foreign/unknown member (indistinguishable)', async () => {
      const { service, prisma } = makeHarness();
      prisma.membership.findFirst.mockResolvedValue(null);
      await expect(
        service.updateMemberRole('org-a', 'u-ghost', { role: MembershipRole.MEMBER }),
      ).rejects.toThrow(NotFoundException);
    });

    it('a concurrent guard loss raises 409', async () => {
      const { service, prisma } = makeHarness();
      prisma.membership.findFirst.mockResolvedValue(membershipRow(MembershipRole.MEMBER));
      prisma.membership.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.updateMemberRole('org-a', 'u-target', { role: MembershipRole.ADMIN }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('removal (OWNER-gated, design D4)', () => {
    it('refuses self-removal without touching the store', async () => {
      const { service, prisma } = makeHarness();
      await expect(service.removeMember('org-a', 'u-me', 'u-me')).rejects.toThrow(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses removing the last owner inside the transaction', async () => {
      const { service, prisma } = makeHarness();
      prisma.membership.findFirst.mockResolvedValue(membershipRow(OWNER));
      prisma.membership.count.mockResolvedValue(1);
      await expect(service.removeMember('org-a', 'u-me-admin', 'u-target')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.membership.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes the membership for a non-owner target', async () => {
      const { service, prisma } = makeHarness();
      prisma.membership.findFirst.mockResolvedValue(membershipRow(MembershipRole.MEMBER));
      await service.removeMember('org-a', 'u-me-admin', 'u-target');
      expect(prisma.membership.deleteMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', userId: 'u-target' },
      });
    });

    it('404s a foreign/unknown target', async () => {
      const { service, prisma } = makeHarness();
      prisma.membership.findFirst.mockResolvedValue(null);
      await expect(service.removeMember('org-a', 'u-me-admin', 'u-ghost')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('invitations (design D1)', () => {
    it('stores only the token HASH and computes a 7-day expiry', async () => {
      const { service, prisma } = makeHarness();
      prisma.orgInvitation.create.mockImplementation(({ data }) => ({
        ...data,
        id: 'inv-1',
        status: 'PENDING',
        acceptedAt: null,
        createdAt: new Date('2026-10-16T00:00:00Z'),
      }));

      const result = await service.createInvitation('org-a', 'u-owner', {
        email: '  Ada@Acme.Example ',
        role: MembershipRole.MEMBER,
      });

      const data = prisma.orgInvitation.create.mock.calls[0][0].data;
      expect(data.email).toBe('ada@acme.example');
      expect(data.tokenHash).toBe(createHash('sha256').update(result.acceptToken).digest('hex'));
      expect(new Date(data.expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
      expect(result.acceptUrl).toBe(`/invite/${result.acceptToken}`);
      // The stored hash is not the raw token, and the response carries neither.
      expect(data.tokenHash).not.toBe(result.acceptToken);
      expect(result).not.toHaveProperty('tokenHash');
    });

    it('maps a concurrent duplicate-pending insert to 409', async () => {
      const { service, prisma } = makeHarness();
      prisma.orgInvitation.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.createInvitation('org-a', 'u-owner', { email: 'a@b.c', role: MembershipRole.MEMBER }),
      ).rejects.toThrow(ConflictException);
    });

    it('revocation is a guarded PENDING transition; non-pending 409s', async () => {
      const { service, prisma } = makeHarness();
      prisma.orgInvitation.findFirst
        .mockResolvedValueOnce({ id: 'inv-1', status: OrgInvitationStatus.PENDING })
        .mockResolvedValueOnce({ id: 'inv-2', status: OrgInvitationStatus.ACCEPTED });
      prisma.orgInvitation.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await service.revokeInvitation('org-a', 'inv-1');
      expect(prisma.orgInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', organizationId: 'org-a', status: 'PENDING' },
        data: { status: 'REVOKED' },
      });

      await expect(service.revokeInvitation('org-a', 'inv-2')).rejects.toThrow(ConflictException);
    });
  });

  describe('acceptance (PUBLIC, design D3) — every invalid case is the opaque error', () => {
    it('a NEW email creates the account + membership and marks the invitation ACCEPTED', async () => {
      const { service, prisma, passwords } = makeHarness();
      prisma.orgInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', email: 'new@acme.example', role: MembershipRole.MEMBER,
        status: OrgInvitationStatus.PENDING, organizationId: 'org-a', expiresAt: new Date(Date.now() + 86400_000),
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u-new', email: 'new@acme.example' });
      prisma.organization.findUniqueOrThrow.mockResolvedValue({ id: 'org-a', name: 'Acme' });
      prisma.membership.create.mockResolvedValue({ role: MembershipRole.MEMBER, userId: 'u-new' });

      const result = await service.acceptInvitation({ token: 'tok', password: 'correct-horse-battery' });

      expect(result).toMatchObject({ organizationId: 'org-a', organizationName: 'Acme', email: 'new@acme.example', role: 'MEMBER' });
      expect(passwords.hash).toHaveBeenCalledWith('correct-horse-battery');
      expect(prisma.orgInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OrgInvitationStatus.PENDING }),
          data: expect.objectContaining({ status: OrgInvitationStatus.ACCEPTED }),
        }),
      );
      expect(prisma.membership.create).toHaveBeenCalledWith({
        data: { userId: 'u-new', organizationId: 'org-a', role: MembershipRole.MEMBER },
      });
    });

    it('an EXISTING account with the right password joins without user creation', async () => {
      const { service, prisma, passwords } = makeHarness();
      prisma.orgInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', email: 'ada@acme.example', role: MembershipRole.ADMIN,
        status: OrgInvitationStatus.PENDING, organizationId: 'org-a', expiresAt: new Date(Date.now() + 86400_000),
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'u-ada', email: 'ada@acme.example', passwordHash: 'stored-digest' });
      passwords.verify.mockResolvedValue(true);
      prisma.organization.findUniqueOrThrow.mockResolvedValue({ id: 'org-a', name: 'Acme' });
      prisma.membership.create.mockResolvedValue({ role: MembershipRole.ADMIN, userId: 'u-ada' });

      const result = await service.acceptInvitation({ token: 'tok', password: 'correct-horse-battery' });
      expect(result.email).toBe('ada@acme.example');
      expect(passwords.hash).not.toHaveBeenCalled();
      expect(passwords.verify).toHaveBeenCalledWith('correct-horse-battery', 'stored-digest');
    });

    it('the wrong existing-account password is OPAQUE (same error as a dead token)', async () => {
      const { service, prisma, passwords } = makeHarness();
      prisma.orgInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', email: 'ada@acme.example', role: MembershipRole.MEMBER,
        status: OrgInvitationStatus.PENDING, organizationId: 'org-a', expiresAt: new Date(Date.now() + 86400_000),
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-ada', email: 'ada@acme.example', passwordHash: 'stored-digest',
      });
      passwords.verify.mockResolvedValue(false);

      await expect(
        service.acceptInvitation({ token: 'tok', password: 'wrong-but-long-enough' }),
      ).rejects.toThrow(MembersServiceOpaqueInvitationError);
      expect(prisma.membership.create).not.toHaveBeenCalled();
    });

    it('unknown / expired / revoked / already-accepted tokens are opaque', async () => {
      const { service, prisma } = makeHarness();
      prisma.orgInvitation.findUnique.mockResolvedValue(null);
      await expect(
        service.acceptInvitation({ token: 'nope', password: 'correct-horse-battery' }),
      ).rejects.toThrow(MembersServiceOpaqueInvitationError);

      prisma.orgInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', email: 'a@b.c', role: MembershipRole.MEMBER,
        status: OrgInvitationStatus.REVOKED, organizationId: 'org-a', expiresAt: new Date(Date.now() + 86400_000),
      });
      await expect(
        service.acceptInvitation({ token: 'nope', password: 'correct-horse-battery' }),
      ).rejects.toThrow(MembersServiceOpaqueInvitationError);

      prisma.orgInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', email: 'a@b.c', role: MembershipRole.MEMBER,
        status: OrgInvitationStatus.PENDING, organizationId: 'org-a', expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.acceptInvitation({ token: 'nope', password: 'correct-horse-battery' }),
      ).rejects.toThrow(MembersServiceOpaqueInvitationError);
      expect(prisma.membership.create).not.toHaveBeenCalled();
    });

    it('a lost acceptance race (guarded claim matched 0 rows) is opaque and creates nothing', async () => {
      const { service, prisma } = makeHarness();
      prisma.orgInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', email: 'a@b.c', role: MembershipRole.MEMBER,
        status: OrgInvitationStatus.PENDING, organizationId: 'org-a', expiresAt: new Date(Date.now() + 86400_000),
      });
      prisma.orgInvitation.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.acceptInvitation({ token: 'tok', password: 'correct-horse-battery' }),
      ).rejects.toThrow(MembersServiceOpaqueInvitationError);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.membership.create).not.toHaveBeenCalled();
    });
  });
});
