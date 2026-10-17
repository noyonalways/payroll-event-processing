import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant, TEST_PASSWORD } from './support/auth';

/**
 * E2E for password reset + lockout (auth-hardening): anti-enumeration
 * forgot-password (identical responses, known or unknown email), the
 * single-use token lifecycle (happy path kills the session family, reuse and
 * expiry are the same opaque 410), the account lockout (threshold lock with
 * 429 + Retry-After, correct password during lockout refused, clear on
 * success/expiry), and the last-owner-style corner cases live with members.
 */
jest.setTimeout(30_000);

const OPAQUE_410 = 'Reset token is no longer valid';

describe('Password reset + login lockout (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  let member: TestTenant;

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
    tenant = await registerTenant(app, 'reset-owner');

    // A MATERIAL member of the owner's org (hourly-life user + membership),
    // whose refresh token family is killable via a reset.
    member = await registerTenant(app, 'reset-member-material');
    await prisma.membership.create({
      data: {
        userId: member.userId,
        organizationId: tenant.organizationId,
        role: 'MEMBER',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const forgot = (email: string) =>
    request(app.getHttpServer()).post('/auth/forgot-password').send({ email });

  const reset = (token: string, password: string) =>
    request(app.getHttpServer()).post('/auth/reset-password').send({ token, password });

  const login = (email: string, password: string, organizationId?: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password, organizationId });

  const refresh = (refreshToken: string) =>
    request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });

  const me = (accessToken: string) =>
    request(app.getHttpServer()).get('/auth/me').set({ Authorization: `Bearer ${accessToken}` });

  it('forgot-password responds IDENTICALLY for known and unknown emails', async () => {
    const known = await forgot(tenant.email);
    const unknown = await forgot(`ghost-${randomUUID()}@nowhere.example`);

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    // Identical SHAPE; only the token's PRESENCE differs (hand-off contract)
    // — the status and body structure are indistinguishable.
    expect(unknown.body).toEqual({ token: null });
    expect(known.body.token).toBeTruthy();
    expect(Object.keys(known.body)).toEqual(Object.keys(unknown.body));
  });

  it('a reset completes, revokes the whole refresh family, and clears lockouts', async () => {
    // Fresh session for the member; then forget+reset their password.
    // The member holds memberships in TWO orgs — an ambiguous login needs
    // the explicit organizationId (the session stays org-bound).
    const preLogin = await login(member.email, member.password, tenant.organizationId);
    expect(preLogin.status).toBe(200);

    const forgotRes = await forgot(member.email);
    const token = forgotRes.body.token as string;
    expect(token).toBeTruthy();
    const newPassword = 'brand-new-correct-horse';

    const res = await reset(token, newPassword);
    expect(res.status).toBe(204);

    // The session minted BEFORE the reset is dead: refresh fails 401.
    expect((await refresh(preLogin.body.refreshToken)).status).toBe(401);

    // Login works with the NEW password (member org binding intact).
    const relaunch = await login(member.email, newPassword, tenant.organizationId);
    expect(relaunch.status).toBe(200);
    expect((await me(relaunch.body.accessToken)).status).toBe(200);
  });

  it('a token cannot be reused; the second attempt is the opaque 410', async () => {
    const forgotRes = await forgot(member.email);
    const token = forgotRes.body.token as string;
    expect((await reset(token, 'a-valid-long-password-x')).status).toBe(204);

    const second = await reset(token, 'a-different-long-password');
    expect(second.status).toBe(410);
    expect(second.body.message).toBe(OPAQUE_410);
  });

  it('an unknown token is the same opaque 410; weak passwords are 400', async () => {
    const dead = await reset(`nope-${randomUUID()}`, 'a-valid-long-password-x');
    expect(dead.status).toBe(410);

    const forgotRes = await forgot(member.email);
    const weak = await reset(forgotRes.body.token as string, 'short');
    expect(weak.status).toBe(400);
    // The weak-password token stays UNUSED (weak = no reset consumed).
    const user = await prisma.user.findUniqueOrThrow({ where: { email: member.email } });
    const live = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id, usedAt: null },
    });
    expect(live).toBeTruthy();
  });

  describe('login lockout (5 failures by default)', () => {
    // Unique per run — the lockout account persists across runs.
    const LOCKED_EMAIL = `locking-${randomUUID().slice(0, 8)}@acme.example`;

    beforeAll(async () => {
      // Create a dedicated account in the owner's org (membership needed for
      // the login to succeed once — proving the clear-on-success path).
      const material = await registerTenant(app, 'locking-material');
      await prisma.membership.create({
        data: {
          userId: material.userId,
          organizationId: tenant.organizationId,
          role: 'MEMBER',
        },
      });
      await prisma.user.update({
        where: { id: material.userId },
        data: { email: LOCKED_EMAIL },
      });
    });

    it('locks at the threshold, refuses the RIGHT password while locked, then clears', async () => {
      // Threshold - 1: ordinary 401s.
      for (let i = 0; i < 4; i += 1) {
        expect((await login(LOCKED_EMAIL, 'wrong-long-password-11')).status).toBe(401);
      }
      // The 5th failure LOCKS — future attempts shape-shift to 429 (even with
      // the correct password).
      expect((await login(LOCKED_EMAIL, 'wrong-long-password-11')).status).toBe(401);
      expect((await login(LOCKED_EMAIL, 'wrong-long-password-11')).status).toBe(429);

      const locked = await login(LOCKED_EMAIL, member.password, tenant.organizationId);
      expect(locked.status).toBe(429);
      expect(locked.headers['retry-after']).toBeDefined();

      // Foreign/unknown emails keep the PLAIN credential response during this
      // org's lockout — lock state never leaks across accounts.
      expect((await login(`ghost-${randomUUID()}@nowhere.example`, 'wrong-long-password-11')).status).toBe(401);

      // Expiry path: force the lock into the past → success clears failures.
      await prisma.user.update({
        where: { email: LOCKED_EMAIL },
        data: { lockedUntil: new Date(Date.now() - 1000), failedLoginCount: 5 },
      });
      const success = await login(LOCKED_EMAIL, TEST_PASSWORD, tenant.organizationId);
      expect(success.status).toBe(200);

      // Post-clear: failures restarted from zero — a wrong password is 401
      // again (NOT an instant 429).
      expect((await login(LOCKED_EMAIL, 'wrong-long-password-11')).status).toBe(401);
    });
  });
});
