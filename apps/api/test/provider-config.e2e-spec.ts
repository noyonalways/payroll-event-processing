import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { MembershipRole } from '@prisma/client';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { PrismaService } from '@repo/database';
import { TestTenant, registerTenant, TEST_PASSWORD } from './support/auth';

/**
 * E2E for the provider-configuration API (real-provider-adapter, design D3):
 * OWNER-gated create/read/delete, the credential-returned-once contract
 * (never in reads, never in logs), validation for HTTP mode (https/loopback),
 * and tenant scoping (the org's own row only; no cross-org access at all).
 */
describe('Provider config API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: TestTenant;
  let other: TestTenant;

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
    owner = await registerTenant(app, 'provider-owner');
    other = await registerTenant(app, 'provider-other');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.providerConfig.deleteMany({});
  });

  const put = (body: object, as: TestTenant = owner) =>
    request(app.getHttpServer()).put('/provider-config').set(as.headers).send(body);

  const get = (as: TestTenant = owner) =>
    request(app.getHttpServer()).get('/provider-config').set(as.headers);

  const del = (as: TestTenant = owner) =>
    request(app.getHttpServer()).delete('/provider-config').set(as.headers);

  describe('PUT /provider-config (OWNER-gated)', () => {
    it('a MEMBER of the organization is 403 — only the OWNER configures', async () => {
      // Bind a member into the owner's organization and log in there (the
      // same second-member path rbac.e2e uses).
      const material = await registerTenant(app, 'provider-member-material');
      await prisma.membership.create({
        data: {
          userId: material.userId,
          organizationId: owner.organizationId,
          role: MembershipRole.MEMBER,
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

      const res = await request(app.getHttpServer())
        .put('/provider-config')
        .set({ Authorization: `Bearer ${login.body.accessToken}` })
        .send({ mode: 'SIMULATED' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ForbiddenException');
      expect(await prisma.providerConfig.count()).toBe(0);
    });

    it('saves an HTTP configuration and returns the credential EXACTLY once', async () => {
      const res = await put({
        mode: 'HTTP',
        baseUrl: 'https://payroll.acme.example/effects',
        credential: 'sk_live_its-a-credential',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        mode: 'HTTP',
        baseUrl: 'https://payroll.acme.example/effects',
        credential: 'sk_live_its-a-credential',
      });

      const read = await get();
      expect(read.status).toBe(200);
      expect(read.body).toEqual({
        mode: 'HTTP',
        baseUrl: 'https://payroll.acme.example/effects',
      });

      // The stored row keeps the recoverable secret for the resolver.
      const row = await prisma.providerConfig.findUniqueOrThrow({
        where: { organizationId: owner.organizationId },
      });
      expect(row.credential).toBe('sk_live_its-a-credential');
    });

    it('replaces the configuration (mode swap clears the stored credential)', async () => {
      await put({ mode: 'HTTP', baseUrl: 'https://x.example/a', credential: 'cred-1' });
      const swapped = await put({ mode: 'SIMULATED' });
      expect(swapped.status).toBe(201);

      const row = await prisma.providerConfig.findUniqueOrThrow({
        where: { organizationId: owner.organizationId },
      });
      expect(row.mode).toBe('SIMULATED');
      expect(row.credential).toBeNull();
      expect(row.baseUrl).toBeNull();
    });

    it('rejects HTTP mode without baseUrl/credential and plaintext public URLs', async () => {
      expect(
        (await put({ mode: 'HTTP', credential: 'cred-1' })).status,
      ).toBe(400);
      expect(
        (await put({ mode: 'HTTP', baseUrl: 'https://x.example/a' })).status,
      ).toBe(400);
      expect(
        (
          await put({
            mode: 'HTTP',
            baseUrl: 'http://insecure.example/a',
            credential: 'cred-1',
          })
        ).status,
      ).toBe(400);
      // Loopback public? No — loopback is precisely the exception.
      expect(
        (
          await put({
            mode: 'HTTP',
            baseUrl: 'http://127.0.0.1:9/hook',
            credential: 'cred-1',
          })
        ).status,
      ).toBe(201);
    });
  });

  describe('GET/DELETE /provider-config', () => {
    it('404s when unconfigured and deletion returns to the simulated default', async () => {
      expect((await get()).status).toBe(404);
      expect((await del()).status).toBe(404);

      await put({ mode: 'SIMULATED' });
      expect((await del()).status).toBe(204);
      expect((await get()).status).toBe(404);
    });

    it('configuration is keyed by the caller’s organization — other orgs see only their own', async () => {
      await put({ mode: 'SIMULATED' });
      await put(
        {
          mode: 'HTTP',
          baseUrl: 'https://other.example/x',
          credential: 'other-cred-1',
        },
        other,
      );

      // Each owner's read shows ONLY its own configuration.
      const ownRead = await get();
      expect(ownRead.body).toEqual({ mode: 'SIMULATED', baseUrl: null });
      const otherRead = await get(other);
      expect(otherRead.body).toEqual({
        mode: 'HTTP',
        baseUrl: 'https://other.example/x',
      });
      // And org B's credential is nowhere in org A's read.
      expect(JSON.stringify(ownRead.body)).not.toContain('other-cred-1');
    });
  });
});
