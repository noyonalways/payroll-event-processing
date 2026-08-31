import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { IDEMPOTENCY_SCOPE_EVENT_SUBMISSION } from '../src/common/idempotency/idempotency.constants';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * E2E for the event submission contract — runs against real Postgres
 * (Docker `postgres` service, reached via localhost from the host).
 *
 * Environment: process.env.DATABASE_URL is set in test/setup-env.ts because
 * the in-process Prisma client does not auto-load .env.
 */
describe('POST /events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
  });

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({});
    await prisma.idempotencyRecord.deleteMany({});
  });

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({}).catch(() => undefined);
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const key = () => randomUUID();
  const employee = (prefix = 'emp') => `${prefix}-${randomUUID()}`;

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

  describe('201 submissions', () => {
    it.each([
      ['BANK_ACCOUNT_CHANGE', bankAccount],
      ['ADDRESS_CHANGE', addressChange],
      ['SALARY_CHANGE', salaryChange],
      ['DEPARTMENT_CHANGE', departmentChange],
    ])('%s returns 201 { id, status: "received" }', async (_name, body) => {
      const res = await http()
        .post('/events')
        .set('Idempotency-Key', key())
        .send(body())
        .expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        status: 'received',
      });
    });
  });

  describe('400 validation', () => {
    it('rejects a missing Idempotency-Key header', async () => {
      await http().post('/events').send(bankAccount()).expect(400);
    });

    it('rejects an unsupported eventType', async () => {
      await http()
        .post('/events')
        .set('Idempotency-Key', key())
        .send({ eventType: 'NONSENSE_EVENT', payload: {} })
        .expect(400);
    });

    it('rejects a missing required payload field', async () => {
      const body = bankAccount();
      delete (body.payload as Record<string, unknown>).iban;

      await http()
        .post('/events')
        .set('Idempotency-Key', key())
        .send(body)
        .expect(400);
    });

    it('rejects a missing DEPARTMENT_CHANGE required field', async () => {
      const body = departmentChange();
      delete (body.payload as Record<string, unknown>).newDepartment;

      await http()
        .post('/events')
        .set('Idempotency-Key', key())
        .send(body)
        .expect(400);
    });

    it('rejects an unknown payload field', async () => {
      const body = salaryChange();
      (body.payload as Record<string, unknown>).bonus = 1_000;

      await http()
        .post('/events')
        .set('Idempotency-Key', key())
        .send(body)
        .expect(400);
    });

    it('rejects an unknown top-level field', async () => {
      const body = { ...bankAccount(), bogus: true };

      await http()
        .post('/events')
        .set('Idempotency-Key', key())
        .send(body)
        .expect(400);
    });
  });

  describe('idempotency', () => {
    it('returns an identical stored response for the same key and writes exactly one row', async () => {
      const immutable = key();
      const body = bankAccount();

      const first = await http()
        .post('/events')
        .set('Idempotency-Key', immutable)
        .send(body)
        .expect(201);
      const second = await http()
        .post('/events')
        .set('Idempotency-Key', immutable)
        .send({ ...body, payload: { ...body.payload } }) // same content, new object
        .expect(201);

      expect(second.body).toEqual(first.body);
      expect(
        await prisma.payrollEvent.count({ where: { idempotencyKey: immutable } }),
      ).toBe(1);
    });

    it('allows key reuse after expiry: creates a new event and replaces the stored response', async () => {
      const reusable = key();
      const body = bankAccount();

      const first = await http()
        .post('/events')
        .set('Idempotency-Key', reusable)
        .send(body)
        .expect(201);

      // Force expiry at the record level. A small IDEMPOTENCY_TTL_SECONDS override
      // can't steer one test: @nestjs/config snapshots process.env at import time,
      // and this direct update is deterministic and scoped to this key.
      const forced = await prisma.idempotencyRecord.update({
        where: {
          scope_key: { scope: IDEMPOTENCY_SCOPE_EVENT_SUBMISSION, key: reusable },
        },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      expect(forced.expiresAt.getTime()).toBeLessThan(Date.now()); // setup applied

      const second = await http()
        .post('/events')
        .set('Idempotency-Key', reusable)
        .send(body)
        .expect(201);

      // Expired → treated as absent → a fresh event row and a fresh id.
      expect(second.body.id).not.toBe(first.body.id);
      expect(second.body).toEqual({ id: second.body.id, status: 'received' });
      expect(
        await prisma.payrollEvent.count({ where: { idempotencyKey: reusable } }),
      ).toBe(2);
      // The (scope, key) record was replaced, not duplicated.
      expect(
        await prisma.idempotencyRecord.count({ where: { key: reusable } }),
      ).toBe(1);
    });

    it('handles concurrent duplicate submissions: one row, both get a stored response', async () => {
      const immutable = key();
      const body = bankAccount();

      const [a, b] = await Promise.all([
        http().post('/events').set('Idempotency-Key', immutable).send(body),
        http().post('/events').set('Idempotency-Key', immutable).send(body),
      ]);

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body).toEqual(b.body);
      expect(
        await prisma.payrollEvent.count({ where: { idempotencyKey: immutable } }),
      ).toBe(1);
    });
  });

  describe('per-employee sequence', () => {
    it('increments sequence for a single employee', async () => {
      const employeeId = employee('seq');
      for (const k of [key(), key()]) {
        await http()
          .post('/events')
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
        where: { employeeId },
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
        http()
          .post('/events')
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

      const s1 = await prisma.payrollEvent.findFirst({ where: { employeeId: e1 } });
      const s2 = await prisma.payrollEvent.findFirst({ where: { employeeId: e2 } });
      expect(s1?.sequence).toBe(1n);
      expect(s2?.sequence).toBe(1n);
    });
  });
});