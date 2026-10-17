import { Test, TestingModule } from '@nestjs/testing';
import { MembershipRole } from '@prisma/client';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { IS_PUBLIC_KEY } from './auth.constants';
import { ActorIdentityDto, SessionResponseDto } from './dto/session-response.dto';

const ACTOR = {
  userId: 'user-1',
  organizationId: 'org-a',
  role: MembershipRole.OWNER,
};

const session: SessionResponseDto = {
  user: { id: 'user-1', email: 'owner@acme.example', name: 'Ada' },
  organization: { id: 'org-a', name: 'Acme Payroll', slug: 'acme-payroll' },
  role: MembershipRole.OWNER,
  accessToken: 'signed.access.token',
  refreshToken: 'refresh-value',
  tokenType: 'Bearer',
  expiresIn: '15m',
  refreshExpiresAt: '2026-11-14T12:00:00.000Z',
};

/** Reads the `@Public()` metadata the global guard consults. */
const isPublic = (handler: (...args: never[]) => unknown): boolean =>
  Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    me: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        // Password reset routes (auth-hardening): the controller delegates.
        { provide: PasswordResetService, useValue: { requestReset: jest.fn(), reset: jest.fn() } },
      ],
    }).compile();

    controller = moduleRef.get<AuthController>(AuthController);
  });

  describe('the public/protected split', () => {
    it('leaves the credential-acquiring routes public', () => {
      // These are how a caller obtains a token, so they cannot require one. Each
      // is authorized by the credential in its own body.
      expect(isPublic(AuthController.prototype.register)).toBe(true);
      expect(isPublic(AuthController.prototype.login)).toBe(true);
      expect(isPublic(AuthController.prototype.refresh)).toBe(true);
      expect(isPublic(AuthController.prototype.logout)).toBe(true);
    });

    it('keeps the identity route protected', () => {
      // No @Public(): the global guard requires an access token by default.
      expect(isPublic(AuthController.prototype.me)).toBe(false);
    });
  });

  describe('POST /auth/register', () => {
    it('delegates the DTO to the service', async () => {
      authService.register.mockResolvedValue(session);
      const dto = {
        email: 'owner@acme.example',
        password: 'correct-horse-battery',
        organizationName: 'Acme Payroll',
      };

      const result = await controller.register(dto);

      expect(authService.register).toHaveBeenCalledWith(dto);
      expect(result).toBe(session);
    });
  });

  describe('POST /auth/login', () => {
    it('delegates the DTO to the service', async () => {
      authService.login.mockResolvedValue(session);
      const dto = { email: 'owner@acme.example', password: 'correct-horse-battery' };

      const result = await controller.login(dto);

      expect(authService.login).toHaveBeenCalledWith(dto);
      expect(result.accessToken).toBe('signed.access.token');
    });
  });

  describe('POST /auth/refresh', () => {
    it('passes the refresh token value through to the service', async () => {
      authService.refresh.mockResolvedValue(session);

      await controller.refresh({ refreshToken: 'presented-refresh' });

      expect(authService.refresh).toHaveBeenCalledWith('presented-refresh');
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the presented token and returns nothing (204)', async () => {
      authService.logout.mockResolvedValue(undefined);

      await expect(controller.logout({ refreshToken: 'presented-refresh' })).resolves.toBeUndefined();
      expect(authService.logout).toHaveBeenCalledWith('presented-refresh');
    });
  });

  describe('GET /auth/me', () => {
    it('resolves the identity for the authenticated actor', async () => {
      const identity: ActorIdentityDto = {
        user: { id: 'user-1', email: 'owner@acme.example', name: 'Ada' },
        organization: { id: 'org-a', name: 'Acme Payroll', slug: 'acme-payroll' },
        role: MembershipRole.OWNER,
      };
      authService.me.mockResolvedValue(identity);

      const result = await controller.me(ACTOR);

      expect(authService.me).toHaveBeenCalledWith(ACTOR);
      expect(result).toEqual(identity);
    });
  });
});
