import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { MembershipRole } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';

const USER_ID = 'user-1';
const ORG = 'org-a';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('TokenService', () => {
  let service: TokenService;

  const jwtService = { signAsync: jest.fn() };
  const prisma = {
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'AUTH_ACCESS_TOKEN_TTL') return '15m';
      if (key === 'AUTH_REFRESH_TOKEN_TTL_DAYS') return 30;
      return fallback;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jwtService.signAsync.mockResolvedValue('signed.access.token');
    prisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });
    prisma.refreshToken.update.mockResolvedValue({ id: 'rt-1' });
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    service = new TokenService(
      jwtService as unknown as JwtService,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('issueSession', () => {
    it('signs an access token carrying the tenant identity and the access marker', async () => {
      await service.issueSession(USER_ID, ORG, MembershipRole.OWNER);

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        { sub: USER_ID, org: ORG, role: MembershipRole.OWNER, type: 'access' },
        { expiresIn: '15m' },
      );
    });

    it('stores only a digest of the refresh token, never the token itself', async () => {
      const session = await service.issueSession(USER_ID, ORG, MembershipRole.OWNER);

      const stored = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(stored.tokenHash).toBe(sha256(session.refreshToken));
      expect(stored.tokenHash).not.toBe(session.refreshToken);
      expect(stored.userId).toBe(USER_ID);
      // The organization is part of the session, so a refresh cannot move tenants.
      expect(stored.organizationId).toBe(ORG);
      expect(JSON.stringify(stored)).not.toContain(session.refreshToken);
    });

    it('expires the refresh token per configuration and reports it back', async () => {
      const session = await service.issueSession(USER_ID, ORG, MembershipRole.MEMBER);

      const expectedMs = 30 * 24 * 60 * 60 * 1000;
      const delta = session.refreshTokenExpiresAt.getTime() - Date.now();
      expect(delta).toBeGreaterThan(expectedMs - 60_000);
      expect(delta).toBeLessThanOrEqual(expectedMs);
      expect(session.accessTokenExpiresIn).toBe('15m');
    });

    it('issues a distinct refresh token per session', async () => {
      const first = await service.issueSession(USER_ID, ORG, MembershipRole.OWNER);
      const second = await service.issueSession(USER_ID, ORG, MembershipRole.OWNER);

      expect(first.refreshToken).not.toBe(second.refreshToken);
    });
  });

  describe('rotate', () => {
    const liveRecord = {
      id: 'rt-1',
      userId: USER_ID,
      organizationId: ORG,
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    };

    it('consumes the presented token and returns the session it stood for', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(liveRecord);

      const result = await service.rotate('presented-token');

      expect(result).toEqual({ userId: USER_ID, organizationId: ORG });
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: sha256('presented-token') },
      });
      // Single-use: the presented row is revoked so it cannot be replayed.
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('rejects an unknown token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.rotate('never-issued')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...liveRecord,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.rotate('stale-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('treats a replayed (already consumed) token as reuse and revokes the whole family', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...liveRecord,
        revokedAt: new Date(Date.now() - 5_000),
      });

      await expect(service.rotate('replayed-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      // Assume the family is compromised: every live token for the user dies, so
      // the legitimate client re-authenticates and the stolen copy is useless.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // The presented row is not "re-consumed".
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('revokes only a live token and never throws for an unknown one', async () => {
      await expect(service.revoke('whatever')).resolves.toBeUndefined();

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: sha256('whatever'), revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('is idempotent — a second sign-out is still a no-op success', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.revoke('already-revoked')).resolves.toBeUndefined();
      await expect(service.revoke('already-revoked')).resolves.toBeUndefined();
    });
  });
});
