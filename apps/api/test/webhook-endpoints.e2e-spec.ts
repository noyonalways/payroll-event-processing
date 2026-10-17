import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import {
  AppModule,
  HttpExceptionFilter,
} from '@repo/core';
import { PrismaService } from '@repo/database';
import { TestTenant, registerTenant } from './support/auth';

/**
 * E2E for the webhook endpoint configuration + delivery observability surface
 * (integrator-webhooks): tenant-scoped CRUD, the secret-shown-once contract,
 * label-conflict 409s, HTTPS-only URLs, DELETE dead-lettering its pending
 * deliveries in the same transaction, and cross-organization reads reporting
 * 404 indistinguishable from unknown ids. Delivery mechanics are covered by
 * webhook-delivery.e2e-spec.ts.
 */
describe('Webhook endpoints + deliveries API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  let otherTenant: TestTenant;

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
    tenant = await registerTenant(app, 'hooks');
    otherTenant = await registerTenant(app, 'hooks-other');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.webhookDeliveryAttempt.deleteMany({});
    await prisma.webhookDelivery.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  const create = (body: object, as: TestTenant = tenant) =>
    request(app.getHttpServer()).post('/webhook-endpoints').set(as.headers).send(body);

  const list = (as: TestTenant = tenant) =>
    request(app.getHttpServer()).get('/webhook-endpoints').set(as.headers);

  const patchOne = (id: string, body: object, as: TestTenant = tenant) =>
    request(app.getHttpServer()).patch(`/webhook-endpoints/${id}`).set(as.headers).send(body);

  const del = (id: string, as: TestTenant = tenant) =>
    request(app.getHttpServer()).delete(`/webhook-endpoints/${id}`).set(as.headers);

  const getDelivery = (id: string, as: TestTenant = tenant) =>
    request(app.getHttpServer()).get(`/webhook-deliveries/${id}`).set(as.headers);

  const listDeliveries = (endpointId: string, as: TestTenant = tenant) =>
    request(app.getHttpServer()).get(`/webhook-endpoints/${endpointId}/deliveries`).set(as.headers);

  /** Inserts a delivery row directly (the outbox writer's shape). */
  const insertDelivery = async (
    endpointId: string,
    organizationId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    prisma.webhookDelivery.create({
      data: {
        organizationId,
        webhookEndpointId: endpointId,
        eventId: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        terminalStatus: 'SUCCESS',
        url: 'https://hooks.other.example/snapshotted',
        status: 'PENDING',
        payload: { eventId: 'evt-x', status: 'SUCCESS' },
        ...overrides,
      },
    });

  describe('POST /webhook-endpoints', () => {
    it('registers an endpoint and returns the signing secret EXACTLY once', async () => {
      const res = await create({
        label: 'acme-hris',
        url: 'https://integrator.example.com/payroll/hooks',
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        label: 'acme-hris',
        url: 'https://integrator.example.com/payroll/hooks',
        active: true,
      });
      // 32 random bytes, base64 — the only response that ever carries it.
      expect(Buffer.from(res.body.signingSecret, 'base64').byteLength).toBe(32);

      const listed = await list();
      const row = listed.body.find((r: { label: string }) => r.label === 'acme-hris');
      expect(row).toBeTruthy();
      expect(row.signingSecret).toBeUndefined();
      expect(Object.keys(row)).not.toContain('secret');

      const readOne = await listDeliveries(res.body.id);
      // A fresh endpoint has no deliveries yet, but the route resolves.
      expect(readOne.status).toBe(200);
    });

    it('rejects plaintext http:// URLs and blank labels with 400', async () => {
      const badUrl = await create({ label: 'insecure', url: 'http://integrator.example.com/hook' });
      expect(badUrl.status).toBe(400);
      expect(badUrl.body.error).toBe('BadRequestException');

      const blank = await create({ label: '', url: 'https://integrator.example.com/hook' });
      expect(blank.status).toBe(400);
      expect(blank.body.error).toBe('BadRequestException');
    });

    it('409s a duplicate label inside the organization', async () => {
      await create({ label: 'dup', url: 'https://a.example/hook' });
      const res = await create({ label: 'dup', url: 'https://b.example/hook' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'ConflictException' });
    });

    it('rejects requests without a token with 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhook-endpoints')
        .send({ label: 'anon', url: 'https://a.example/hook' });
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /webhook-endpoints/:id', () => {
    it('updates url, label and active flag; secrets are not patchable', async () => {
      const created = (await create({ label: 'patch-me', url: 'https://a.example/v1' })).body;

      const res = await patchOne(created.id, {
        url: 'https://a.example/v2',
        label: 'renamed',
        active: false,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: created.id,
        label: 'renamed',
        url: 'https://a.example/v2',
        active: false,
      });
      expect(res.body.signingSecret).toBeUndefined();
    });

    it('404s another organization’s endpoint (indistinguishable from unknown)', async () => {
      const created = (await create({ label: 'mine', url: 'https://a.example/v1' })).body;
      const res = await patchOne(created.id, { active: false }, otherTenant);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /webhook-endpoints/:id', () => {
    it('dead-letters pending deliveries with reason endpoint_removed and keeps history', async () => {
      const created = (await create({ label: 'doomed', url: 'https://a.example/hook' })).body;
      const pending = await insertDelivery(created.id, tenant.organizationId);
      const delivered = await insertDelivery(created.id, tenant.organizationId, {
        status: 'DELIVERED',
        deliveredAt: new Date(),
        nextAttemptAt: null,
      });

      const res = await del(created.id);
      expect(res.status).toBe(204);

      const afterPending = await prisma.webhookDelivery.findUnique({ where: { id: pending.id } });
      expect(afterPending).toMatchObject({
        status: 'DEAD_LETTERED',
        deadLetterReason: 'endpoint_removed',
        nextAttemptAt: null,
      });
      // Delivered history untouched, url snapshot intact.
      const afterDelivered = await prisma.webhookDelivery.findUnique({ where: { id: delivered.id } });
      expect(afterDelivered).toMatchObject({ status: 'DELIVERED', url: 'https://hooks.other.example/snapshotted' });

      // Deleting again (now unknown) is a 404.
      expect((await del(created.id)).status).toBe(404);
    });

    it('404s another organization’s endpoint', async () => {
      const created = (await create({ label: 'theirs-target', url: 'https://a.example/hook' })).body;
      const res = await del(created.id, otherTenant);
      expect(res.status).toBe(404);
    });
  });

  describe('delivery observability', () => {
    it('lists an endpoint’s deliveries tenant-scoped, newest first, with attempt trails', async () => {
      const created = (await create({ label: 'observe', url: 'https://a.example/hook' })).body;

      const older = await insertDelivery(created.id, tenant.organizationId);
      const newer = await insertDelivery(created.id, tenant.organizationId, {
        status: 'DEAD_LETTERED',
        deadLetterReason: 'retries_exhausted',
        attempts: 3,
        nextAttemptAt: null,
      });
      // A delivery of the OTHER tenant, pointing at this endpoint id in name
      // only — must never leak into tenant A's list.
      await insertDelivery(created.id, otherTenant.organizationId, {
        webhookEndpointId: null,
      });

      const res = await listDeliveries(created.id);
      expect(res.status).toBe(200);
      const ids = res.body.map((d: { id: string }) => d.id);
      expect(ids).toEqual([newer.id, older.id]);
      const dead = res.body.find((d: { id: string }) => d.id === newer.id);
      expect(dead).toMatchObject({
        status: 'DEAD_LETTERED',
        deadLetterReason: 'retries_exhausted',
        attempts: 3,
        url: 'https://hooks.other.example/snapshotted',
      });
      expect(dead.attemptTrail).toEqual([]);

      // Detail read works too.
      const detail = await getDelivery(older.id);
      expect(detail.status).toBe(200);
      expect(detail.body.webhookEndpointId).toBe(created.id);
    });

    it('404s another organization’s delivery detail and endpoint listing', async () => {
      const created = (await create({ label: 'secret-scope', url: 'https://a.example/hook' })).body;
      const delivery = await insertDelivery(created.id, tenant.organizationId);

      expect((await getDelivery(delivery.id, otherTenant)).status).toBe(404);
      expect((await listDeliveries(created.id, otherTenant)).status).toBe(404);
    });
  });
});
