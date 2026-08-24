import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * E2E for the Redis-down contract — Postgres required, Redis must NOT be
 * reachable on the port this suite points REDIS_PORT at.
 *
 * The module is compiled with `process.env.REDIS_PORT` pointed at a dead port so
 * the queue's ioredis client can never connect. The submission pipeline races the
 * enqueue against a wall-clock timeout: `POST /events` must still return
 * `201 { id, status: 'received' }`, the row must be persisted (marked `queued`),
 * and no error may surface. The stored-response short-circuit must hold too —
 * a duplicate `Idempotency-Key` returns the stored response without touching the
 * queue again.
 *
 * `.env.test` is loaded by ConfigModule, but dotenv does not override an existing
 * `process.env.REDIS_PORT`, so the override below wins while this file runs.
 */
jest.setTimeout(30_000);

describe('POST /events with Redis unreachable (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let deadPort: string;

  beforeAll(async () => {
    deadPort = String(63_099 + Math.floor(Math.random() * 100));
    process.env.REDIS_PORT = deadPort;

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
  });

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.REDIS_PORT;
    await app?.close();
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());
  const key = () => randomUUID();

  const bankAccount = (employeeId: string) => ({
    eventType: 'BANK_ACCOUNT_CHANGE',
    payload: {
      employeeId,
      effectiveDate: '2026-09-01',
      iban: 'DE89370400440532013000',
    },
  });

  describe('submission with Redis down', () => {
    it('returns 201 and persists the row without surfacing an error', async () => {
      const employeeId = `redown-${randomUUID()}`;
      const idempotencyKey = key();

      const res = await http()
        .post('/events')
        .set('Idempotency-Key', idempotencyKey)
        .send(bankAccount(employeeId))
        .expect(201);

      expect(res.body).toEqual({ id: expect.any(String), status: 'received' });

      // Row persisted and marked queued (the enqueue timed out — recoverable).
      const row = await prisma.payrollEvent.findUnique({
        where: { id: res.body.id },
      });
      expect(row).not.toBeNull();
      expect(row?.status).toBe('QUEUED');
    });

    it('re-submitting the same key returns the stored response and writes no second row', async () => {
      const employeeId = `redown-${randomUUID()}`;
      const idempotencyKey = key();
      const body = bankAccount(employeeId);

      const first = await http()
        .post('/events')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);
      const second = await http()
        .post('/events')
        .set('Idempotency-Key', idempotencyKey)
        .send({ ...body, payload: { ...body.payload } })
        .expect(201);

      expect(second.body).toEqual(first.body);
      expect(
        await prisma.payrollEvent.count({ where: { idempotencyKey } }),
      ).toBe(1);
    });
  });
});