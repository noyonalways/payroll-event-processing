import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { DEMO_EMPLOYEE_DEPARTMENT, DEMO_EMPLOYEE_SEEDS } from '@repo/shared';
import { PrismaService } from '@repo/database';
import { AuthService } from './auth.service';
import { AuthenticatedActor } from './authenticated-actor';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const USER_ID = 'user-1';
const ORG = 'org-a';

const uniqueViolation = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target },
  });

describe('AuthService', () => {
  let service: AuthService;

  const user = {
    id: USER_ID,
    email: 'owner@acme.example',
    passwordHash: 'scrypt$stored$digest',
    name: 'Ada Lovelace',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const organization = {
    id: ORG,
    name: 'Acme Payroll',
    slug: 'acme-payroll',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const membership = {
    id: 'mem-1',
    userId: USER_ID,
    organizationId: ORG,
    role: MembershipRole.OWNER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const membershipWithTenant = { ...membership, organization, user };

  const tx = {
    organization: { create: jest.fn() },
    user: { create: jest.fn() },
    membership: { create: jest.fn() },
    employee: { createMany: jest.fn() },
  };
  const prisma = {
    user: { findUnique: jest.fn() },
    membership: { findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };
  const passwords = { hash: jest.fn(), verify: jest.fn() };
  const tokens = { issueSession: jest.fn(), rotate: jest.fn(), revoke: jest.fn() };

  const issued = {
    accessToken: 'signed.access.token',
    refreshToken: 'refresh-value',
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresAt: new Date('2026-11-14T12:00:00.000Z'),
  };

  const registerDto = {
    email: 'Owner@Acme.Example',
    password: 'correct-horse-battery',
    name: 'Ada Lovelace',
    organizationName: 'Acme Payroll',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    passwords.hash.mockResolvedValue('scrypt$fresh$digest');
    passwords.verify.mockResolvedValue(true);
    tokens.issueSession.mockResolvedValue(issued);
    tx.organization.create.mockResolvedValue(organization);
    tx.user.create.mockResolvedValue(user);
    tx.membership.create.mockResolvedValue(membershipWithTenant);
    tx.employee.createMany.mockResolvedValue({ count: 5 });
    prisma.user.findUnique.mockResolvedValue(null);
    service = new AuthService(
      prisma as unknown as PrismaService,
      passwords as unknown as PasswordService,
      tokens as unknown as TokenService,
    );
  });

  describe('register (creates a tenant)', () => {
    it('creates the organization, the user and an OWNER membership in one transaction', async () => {
      const result = await service.register(registerDto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.organization.create).toHaveBeenCalledWith({
        data: { name: 'Acme Payroll', slug: 'acme-payroll' },
      });
      expect(tx.user.create).toHaveBeenCalledWith({
        data: {
          email: 'owner@acme.example', // normalized to lower case
          passwordHash: 'scrypt$fresh$digest', // never the plaintext
          name: 'Ada Lovelace',
        },
      });
      expect(tx.membership.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, organizationId: ORG, role: MembershipRole.OWNER },
        include: { organization: true, user: true },
      });

      expect(tokens.issueSession).toHaveBeenCalledWith(USER_ID, ORG, MembershipRole.OWNER);
      expect(result).toEqual({
        user: { id: USER_ID, email: 'owner@acme.example', name: 'Ada Lovelace' },
        organization: { id: ORG, name: 'Acme Payroll', slug: 'acme-payroll' },
        role: MembershipRole.OWNER,
        accessToken: 'signed.access.token',
        refreshToken: 'refresh-value',
        tokenType: 'Bearer',
        expiresIn: '15m',
        refreshExpiresAt: '2026-11-14T12:00:00.000Z',
      });
    });

    it('seeds the five reserved demo employees for the new organization in the same transaction', async () => {
      await service.register(registerDto);

      // Same transaction, after the membership: the partially-created-tenant
      // guarantee extends to a directory that can pass the submission gate
      // (employee-directory design D7).
      expect(tx.employee.createMany).toHaveBeenCalledTimes(1);
      expect(tx.membership.create).toHaveBeenCalled();
      const args = tx.employee.createMany.mock.calls[0][0] as {
        data: Array<{ organizationId: string; employeeNumber: string; name: string; department: string; active: boolean }>;
        skipDuplicates: boolean;
      };
      expect(args.skipDuplicates).toBe(true);
      expect(args.data.map((d) => d.employeeNumber).sort()).toEqual(
        DEMO_EMPLOYEE_SEEDS.map((s) => s.employeeNumber).sort(),
      );
      expect(new Set(args.data.map((d) => d.organizationId))).toEqual(new Set([ORG]));
      expect(args.data.every((d) => d.active === true)).toBe(true);
      expect(args.data.every((d) => d.department === DEMO_EMPLOYEE_DEPARTMENT)).toBe(true);
    });

    it('never persists the plaintext password', async () => {
      await service.register(registerDto);

      const stored = tx.user.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(JSON.stringify(stored)).not.toContain('correct-horse-battery');
    });

    it('rejects an email that already has an account, without creating anything', async () => {
      prisma.user.findUnique.mockResolvedValue(user);

      await expect(service.register(registerDto)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('reports a concurrent same-email race as the same conflict', async () => {
      // Pre-check missed; the other registrant won users_email_key.
      tx.user.create.mockRejectedValue(uniqueViolation(['email']));

      await expect(service.register(registerDto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('disambiguates a taken organization slug instead of failing', async () => {
      tx.organization.create
        .mockRejectedValueOnce(uniqueViolation(['slug']))
        .mockResolvedValueOnce(organization);

      const result = await service.register({
        ...registerDto,
        organizationName: 'Acme Payroll',
      });

      expect(tx.organization.create).toHaveBeenCalledTimes(2);
      const secondSlug = tx.organization.create.mock.calls[1][0].data.slug as string;
      // Two companies may share a display name, so the slug is generated.
      expect(secondSlug).toMatch(/^acme-payroll-[0-9a-f]{6}$/);
      expect(result.organization.id).toBe(ORG);
    });

    it('falls back to a usable slug when the name has no alphanumerics', async () => {
      await service.register({ ...registerDto, organizationName: '###' });

      expect(tx.organization.create).toHaveBeenCalledWith({
        data: { name: '###', slug: 'org' },
      });
    });
  });

  describe('login', () => {
    const loginDto = { email: 'owner@acme.example', password: 'correct-horse-battery' };

    it('issues a session bound to the single membership', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.membership.findMany.mockResolvedValue([membershipWithTenant]);

      const result = await service.login(loginDto);

      expect(passwords.verify).toHaveBeenCalledWith(loginDto.password, user.passwordHash);
      expect(tokens.issueSession).toHaveBeenCalledWith(USER_ID, ORG, MembershipRole.OWNER);
      expect(result.accessToken).toBe('signed.access.token');
      expect(result.organization.id).toBe(ORG);
    });

    it('looks the account up by normalized email', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.membership.findMany.mockResolvedValue([membershipWithTenant]);

      await service.login({ ...loginDto, email: '  OWNER@acme.EXAMPLE ' });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'owner@acme.example' },
      });
    });

    it('rejects a wrong password with an opaque 401', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      passwords.verify.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('rejects an unknown email with the same 401 and still does the work', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const rejection = await service.login(loginDto).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(UnauthorizedException);
      expect((rejection as UnauthorizedException).message).toBe('Invalid email or password');
      // Timing is equalized by verifying against a throwaway digest, so response
      // time does not reveal whether the account exists.
      expect(passwords.verify).toHaveBeenCalledTimes(1);
      expect(passwords.hash).toHaveBeenCalled();
    });

    it('requires an explicit organization when the account belongs to several', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.membership.findMany.mockResolvedValue([
        membershipWithTenant,
        { ...membershipWithTenant, id: 'mem-2', organizationId: 'org-b' },
      ]);

      await expect(service.login(loginDto)).rejects.toBeInstanceOf(BadRequestException);
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('signs in to the named organization when one is supplied', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.membership.findUnique.mockResolvedValue(membershipWithTenant);

      await service.login({ ...loginDto, organizationId: ORG });

      expect(prisma.membership.findUnique).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: USER_ID, organizationId: ORG } },
        include: { organization: true, user: true },
      });
      expect(tokens.issueSession).toHaveBeenCalledWith(USER_ID, ORG, MembershipRole.OWNER);
    });

    it('reports a named organization the account is not a member of as unauthorized', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.membership.findUnique.mockResolvedValue(null);

      // A 401 rather than a 403: whether an organization exists is not something
      // an unauthenticated caller may probe.
      await expect(
        service.login({ ...loginDto, organizationId: 'org-somebody-else' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('rejects an account with no memberships at all', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.membership.findMany.mockResolvedValue([]);

      await expect(service.login(loginDto)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('refresh', () => {
    it('re-validates the membership before issuing a new session', async () => {
      tokens.rotate.mockResolvedValue({ userId: USER_ID, organizationId: ORG });
      prisma.membership.findUnique.mockResolvedValue(membershipWithTenant);

      const result = await service.refresh('presented-refresh');

      expect(tokens.rotate).toHaveBeenCalledWith('presented-refresh');
      expect(prisma.membership.findUnique).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: USER_ID, organizationId: ORG } },
        include: { organization: true, user: true },
      });
      expect(tokens.issueSession).toHaveBeenCalledWith(USER_ID, ORG, MembershipRole.OWNER);
      expect(result.refreshToken).toBe('refresh-value');
    });

    it('rejects the refresh when the membership no longer exists', async () => {
      tokens.rotate.mockResolvedValue({ userId: USER_ID, organizationId: ORG });
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(service.refresh('presented-refresh')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('delegates revocation of the presented token', async () => {
      tokens.revoke.mockResolvedValue(undefined);

      await service.logout('presented-refresh');

      expect(tokens.revoke).toHaveBeenCalledWith('presented-refresh');
    });
  });

  describe('me', () => {
    const actor: AuthenticatedActor = {
      userId: USER_ID,
      organizationId: ORG,
      role: MembershipRole.OWNER,
    };

    it('returns the identity for the organization the token is scoped to', async () => {
      prisma.membership.findUnique.mockResolvedValue(membershipWithTenant);

      const result = await service.me(actor);

      expect(prisma.membership.findUnique).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: USER_ID, organizationId: ORG } },
        include: { organization: true, user: true },
      });
      expect(result).toEqual({
        user: { id: USER_ID, email: 'owner@acme.example', name: 'Ada Lovelace' },
        organization: { id: ORG, name: 'Acme Payroll', slug: 'acme-payroll' },
        role: MembershipRole.OWNER,
      });
      // No credential material of any kind.
      expect(JSON.stringify(result)).not.toContain('scrypt');
    });

    it('rejects a token whose organization is no longer accessible', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(service.me(actor)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
