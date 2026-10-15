import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { MembershipRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../auth.constants';
import { AuthenticatedRequest } from '../authenticated-actor';
import { JwtAuthGuard } from './jwt-auth.guard';

const ORG = 'org-a';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;

  const reflector = { getAllAndOverride: jest.fn() };
  const jwtService = { verifyAsync: jest.fn() };

  const request = (authorization?: string): AuthenticatedRequest =>
    ({ headers: authorization === undefined ? {} : { authorization } }) as AuthenticatedRequest;

  const contextFor = (req: AuthenticatedRequest): ExecutionContext =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    reflector.getAllAndOverride.mockReturnValue(false); // deny by default
    guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      jwtService as unknown as JwtService,
    );
  });

  it('lets a @Public() route through without a token', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);

    await expect(guard.canActivate(contextFor(request()))).resolves.toBe(true);
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('reads the public flag from both the handler and its controller', async () => {
    // No token supplied, so the guard rejects — the metadata read still happens.
    await expect(guard.canActivate(contextFor(request()))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      undefined,
      undefined,
    ]);
  });

  describe('missing credentials', () => {
    it('rejects a request with no Authorization header', async () => {
      await expect(guard.canActivate(contextFor(request()))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a header that is not a bearer scheme', async () => {
      await expect(guard.canActivate(contextFor(request('Basic dXNlcjpwYXNz')))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a bearer header with an empty token', async () => {
      await expect(guard.canActivate(contextFor(request('Bearer    ')))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('invalid credentials', () => {
    it('rejects a token that fails verification', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(
        guard.canActivate(contextFor(request('Bearer expired-or-forged'))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('does not reveal why verification failed', async () => {
      const messages: string[] = [];
      for (const failure of ['jwt expired', 'invalid signature', 'jwt malformed']) {
        jwtService.verifyAsync.mockRejectedValueOnce(new Error(failure));
        const error = await guard
          .canActivate(contextFor(request('Bearer x')))
          .then(() => null)
          .catch((e: UnauthorizedException) => e);

        expect(error).toBeInstanceOf(UnauthorizedException);
        messages.push((error as UnauthorizedException).message);
      }

      // One opaque message for every cause: expired, tampered, and malformed are
      // indistinguishable to the caller.
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('Invalid or expired access token');
    });

    it('rejects a refresh token presented as an access token', async () => {
      // Validly signed, but the `type` claim marks it as the wrong credential.
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        org: ORG,
        role: MembershipRole.OWNER,
        type: 'refresh',
      });

      await expect(
        guard.canActivate(contextFor(request('Bearer refresh-token'))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a token missing the identity or tenant claim', async () => {
      for (const claims of [
        { org: ORG, role: MembershipRole.OWNER, type: 'access' },
        { sub: 'user-1', role: MembershipRole.OWNER, type: 'access' },
      ]) {
        jwtService.verifyAsync.mockResolvedValueOnce(claims);
        await expect(
          guard.canActivate(contextFor(request('Bearer incomplete'))),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
    });
  });

  describe('valid credentials', () => {
    const claims = {
      sub: 'user-1',
      org: ORG,
      role: MembershipRole.OWNER,
      type: 'access',
    };

    it('attaches the tenant identity resolved from the signed claims', async () => {
      jwtService.verifyAsync.mockResolvedValue(claims);
      const req = request('Bearer good-token');

      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('good-token');
      expect(req.actor).toEqual({
        userId: 'user-1',
        organizationId: ORG,
        role: MembershipRole.OWNER,
      });
    });

    it('takes the organization from the token, never from the request', async () => {
      jwtService.verifyAsync.mockResolvedValue(claims);
      // A caller smuggling a tenant into headers/query must have no effect.
      const req = {
        headers: { authorization: 'Bearer good-token' },
        query: { organizationId: 'org-attacker' },
      } as unknown as AuthenticatedRequest;

      await guard.canActivate(contextFor(req));

      expect(req.actor?.organizationId).toBe(ORG);
    });
  });
});
