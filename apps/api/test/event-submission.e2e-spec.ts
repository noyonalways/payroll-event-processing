import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { IDEMPOTENCY_SCOPE_EVENT_SUBMISSION } from '@repo/shared';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';
import { DirectoryEmployees } from './support/directory';

/**
 * E2E for the event submission contract — runs against real Postgres
 * (Docker `postgres` service, reached via localhost from the host).
 *
 * Every submission is made by an authenticated organization: `POST /events` is
 * tenant-scoped, so the suite registers a real tenant through the HTTP surface
 * and reuses its token. The organization is therefore part of every assertion —
 * including the idempotency record, whose identity is
 * `(organization_id, scope, key)`.
 *
 * Environment: process.env.DATABASE_URL is set in test/setup-env.ts because
 * the in-process Prisma client does not auto-load .env.
 */
describe('POST /events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  /** Pre-created gate-valid employee numbers for this suite's tenant. */
  let employees: DirectoryEmployees;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror src/main.ts so e2e exercises the exact production pipeline.
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
    tenant = await registerTenant(app, 'submit');
    // Every handed-out employeeId is a pre-created ACTIVE directory member of
    // the submitting tenant — the submission gate accepts nothing else.
    employees = new DirectoryEmployees(prisma, tenant.organizationId);
    await employees.seed('emp', 100);
    await employees.seed('seq', 10);
    await employees.seed('ind', 10);
  });

  const employee = (prefix = 'emp') => employees.draw(prefix);

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({});
    await prisma.idempotencyRecord.deleteMany({});
  });

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({}).catch(() => undefined);
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await app.close();
  });

  /** Authenticated POST /events — the tenant's token is always attached. */
  const submit = () => request(app.getHttpServer()).post('/events').set(tenant.headers);
  const key = () => randomUUID();

  const bankAccount = () => ({
    eventType: 'BANK_ACCOUNT_CHANGE',
    payload: {
      employeeId: employee(),
      effectiveDate: '2026-09-01',
      iban: 'DE89370400440532013000',
    },
  });
  const addressChange = () => ({
    eventType: 'ADDRESS_CHANGE',
    payload: {
      employeeId: employee(),
      effectiveDate: '2026-09-01',
      street: 'Main St',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    },
  });
  const salaryChange = () => ({
    eventType: 'SALARY_CHANGE',
    payload: {
      employeeId: employee(),
      effectiveDate: '2026-09-01',
      newSalary: 75_000,
      currency: 'EUR',
    },
  });
  const departmentChange = () => ({
    eventType: 'DEPARTMENT_CHANGE',
    payload: {
      employeeId: employee(),
      effectiveDate: '2026-09-01',
      newDepartment: 'Engineering',
    },
  });

  describe('authentication is required', () => {
    it('rejects a submission with a valid key but no access token', async () => {
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key())
        .send(bankAccount())
        .expect(401);

      // Nothing was persisted for the rejected attempt.
      expect(await prisma.payrollEvent.count({})).toBe(0);
    });

    it('rejects a submission with a tampered token', async () => {
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key())
        .set('Authorization', `Bearer ${tenant.accessToken}tampered`)
        .send(bankAccount())
        .expect(401);
    });
  });

  describe('201 submissions', () => {
    it.each([
      ['BANK_ACCOUNT_CHANGE', bankAccount],
      ['ADDRESS_CHANGE', addressChange],
      ['SALARY_CHANGE', salaryChange],
      ['DEPARTMENT_CHANGE', departmentChange],
    ])('%s returns 201 { id, status: "received" }', async (_name, body) => {
      const res = await submit().set('Idempotency-Key', key()).send(body()).expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        status: 'received',
      });
    });

    it('records the caller’s organization on the persisted row', async () => {
      const res = await submit().set('Idempotency-Key', key()).send(bankAccount()).expect(201);

      const row = await prisma.payrollEvent.findUnique({ where: { id: res.body.id } });
      expect(row?.organizationId).toBe(tenant.organizationId);
    });
  });

  describe('400 validation', () => {
    it('rejects a missing Idempotency-Key header', async () => {
      await submit().send(bankAccount()).expect(400);
    });

    it('rejects an unsupported eventType', async () => {
      await submit()
        .set('Idempotency-Key', key())
        .send({ eventType: 'NONSENSE_EVENT', payload: {} })
        .expect(400);
    });

    it('rejects a missing required payload field', async () => {
      const body = bankAccount();
      delete (body.payload as Record<string, unknown>).iban;

      await submit().set('Idempotency-Key', key()).send(body).expect(400);
    });

    it('rejects a missing DEPARTMENT_CHANGE required field', async () => {
      const body = departmentChange();
      delete (body.payload as Record<string, unknown>).newDepartment;

      await submit().set('Idempotency-Key', key()).send(body).expect(400);
    });

    it('rejects an unknown payload field', async () => {
      const body = salaryChange();
      (body.payload as Record<string, unknown>).bonus = 1_000;

      await submit().set('Idempotency-Key', key()).send(body).expect(400);
    });

    it('rejects an unknown top-level field', async () => {
      const body = { ...bankAccount(), bogus: true };

      await submit().set('Idempotency-Key', key()).send(body).expect(400);
    });
  });

  describe('idempotency', () => {
    it('returns an identical stored response for the same key and writes exactly one row', async () => {
      const immutable = key();
      const body = bankAccount();

      const first = await submit().set('Idempotency-Key', immutable).send(body).expect(201);
      const second = await submit()
        .set('Idempotency-Key', immutable)
        .send({ ...body, payload: { ...body.payload } }) // same content, new object
        .expect(201);

      expect(second.body).toEqual(first.body);
      expect(
        await prisma.payrollEvent.count({
          where: { idempotencyKey: immutable, organizationId: tenant.organizationId },
        }),
      ).toBe(1);
    });

    it('allows key reuse after expiry: creates a new event and replaces the stored response', async () => {
      const reusable = key();
      const body = bankAccount();

      const first = await submit().set('Idempotency-Key', reusable).send(body).expect(201);

      // Force expiry at the record level. A small IDEMPOTENCY_TTL_SECONDS override
      // can't steer one test: @nestjs/config snapshots process.env at import time,
      // and this direct update is deterministic and scoped to this key.
      const forced = await prisma.idempotencyRecord.update({
        where: {
          organizationId_scope_key: {
            organizationId: tenant.organizationId,
            scope: IDEMPOTENCY_SCOPE_EVENT_SUBMISSION,
            key: reusable,
          },
        },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      expect(forced.expiresAt.getTime()).toBeLessThan(Date.now()); // setup applied

      const second = await submit().set('Idempotency-Key', reusable).send(body).expect(201);

      // Expired → treated as absent → a fresh event row and a fresh id.
      expect(second.body.id).not.toBe(first.body.id);
      expect(second.body).toEqual({ id: second.body.id, status: 'received' });
      expect(
        await prisma.payrollEvent.count({
          where: { idempotencyKey: reusable, organizationId: tenant.organizationId },
        }),
      ).toBe(2);
      // The (organization, scope, key) record was replaced, not duplicated.
      expect(await prisma.idempotencyRecord.count({ where: { key: reusable } })).toBe(1);
    });

    it('handles concurrent duplicate submissions: one row, both get a stored response', async () => {
      const immutable = key();
      const body = bankAccount();

      const [a, b] = await Promise.all([
        submit().set('Idempotency-Key', immutable).send(body),
        submit().set('Idempotency-Key', immutable).send(body),
      ]);

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body).toEqual(b.body);
      expect(
        await prisma.payrollEvent.count({
          where: { idempotencyKey: immutable, organizationId: tenant.organizationId },
        }),
      ).toBe(1);
    });
  });

  describe('per-employee sequence', () => {
    it('increments sequence for a single employee', async () => {
      const employeeId = employee('seq');
      for (const k of [key(), key()]) {
        await submit()
          .set('Idempotency-Key', k)
          .send({
            eventType: 'BANK_ACCOUNT_CHANGE',
            payload: {
              employeeId,
              effectiveDate: '2026-09-01',
              iban: 'DE89370400440532013000',
            },
          })
          .expect(201);
      }

      const rows = await prisma.payrollEvent.findMany({
        where: { employeeId, organizationId: tenant.organizationId },
        orderBy: { sequence: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].sequence).toBe(1n);
      expect(rows[1].sequence).toBe(rows[0].sequence + 1n);
    });

    it('keeps independent counters per employee', async () => {
      const e1 = employee('ind');
      const e2 = employee('ind');

      const submitOne = async (employeeId: string) =>
        submit()
          .set('Idempotency-Key', key())
          .send({
            eventType: 'ADDRESS_CHANGE',
            payload: {
              employeeId,
              effectiveDate: '2026-09-01',
              street: 'Main St',
              city: 'Berlin',
              postalCode: '10115',
              country: 'DE',
            },
          })
          .expect(201);

      await submitOne(e1);
      await submitOne(e2);

      const s1 = await prisma.payrollEvent.findFirst({
        where: { employeeId: e1, organizationId: tenant.organizationId },
      });
      const s2 = await prisma.payrollEvent.findFirst({
        where: { employeeId: e2, organizationId: tenant.organizationId },
      });
      expect(s1?.sequence).toBe(1n);
      expect(s2?.sequence).toBe(1n);
    });
  });
});
