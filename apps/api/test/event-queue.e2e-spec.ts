import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter, WorkerModule } from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';
import { DirectoryEmployees } from './support/directory';

/**
 * E2E for the full queue pipeline — REAL Postgres + REAL Redis required
 * (`docker compose up` brings up both; the existing suites already need
 * Postgres, this one additionally needs the `redis` service on localhost:6379).
 *
 * The API module and the worker module are booted in the same process, so a
 * submission flows through the real consumer: POST → row `queued` → the
 * `PayrollEventProcessor` claims (`processing`) → succeeds (`success` +
 * `processed_at`) → relays the next pending event for the same employee. Every
 * submission is made by an authenticated tenant (registered through the real
 * HTTP surface), so the pipeline is exercised exactly as a client drives it.
 *
 * Environment: process.env.DATABASE_URL / REDIS_HOST / REDIS_PORT come from
 * `.env.test` (loaded by ConfigModule once test/setup-env.ts pins NODE_ENV).
 *
 * NOTE: every DB-writing e2e suite clears rows with `deleteMany({})` against the
 * shared Postgres, so they must NOT run concurrently. `test/jest-e2e.json`
 * therefore sets `maxWorkers: 1` — running this file in parallel with another
 * suite deletes their in-flight rows (and vice versa) and produces false failures.
 */
jest.setTimeout(30_000);

describe('POST /events → worker queue pipeline (e2e)', () => {
  let app: INestApplication;
  let workerApp: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  /* Pre-created gate-valid employees for this suite's tenant. */
  let employees: DirectoryEmployees;

  beforeAll(async () => {
    // The simulated provider reads these rates at module build; pin a
    // deterministic success so this pipeline suite never flakes (change
    // simulated-payroll-processor). Restored in afterAll so a later e2e file
    // that shares this worker process is unaffected.
    process.env.PAYROLL_FAILURE_MODE = 'always-success';

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
    tenant = await registerTenant(app, 'event-queue');
    employees = new DirectoryEmployees(prisma, tenant.organizationId);
    await employees.seed('pipe', 3);
    await employees.seed('burst', 3);

    // Boot the real consumer so the queue is actually drained.
    const workerModuleRef: TestingModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    workerApp = workerModuleRef.createNestApplication();
    await workerApp.init();
  });

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({});
    await prisma.eventAttempt.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await workerApp?.close();
    await app?.close();
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await prisma.eventAttempt.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());
  const key = () => randomUUID();
  const employee = (prefix: string) => employees.draw(prefix);

  const submit = async (employeeId: string, idempotencyKey: string) =>
    http()
      .post('/events')
      .set(tenant.headers)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        eventType: 'BANK_ACCOUNT_CHANGE',
        payload: {
          employeeId,
          effectiveDate: '2026-09-01',
          iban: 'DE89370400440532013000',
        },
      })
      .expect(201);

  /** Polls Postgres until `predicate` returns a truthy value or the deadline hits. */
  const waitFor = async <T>(
    predicate: () => Promise<T | null>,
    { timeout = 15_000, interval = 50 } = {},
  ): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('Timed out waiting for the worker pipeline');
  };

  describe('single event lifecycle', () => {
    it('drains the event to success with processed_at and a stored result', async () => {
      const employeeId = employee('pipe');
      const idempotencyKey = key();
      const id = (await submit(employeeId, idempotencyKey)).body.id as string;

      const row = await waitFor(async () => {
        const found = await prisma.payrollEvent.findFirst({
          where: { id, organizationId: tenant.organizationId },
        });
        return found?.status === 'SUCCESS' ? found : null;
      });

      expect(row.status).toBe('SUCCESS');
      expect(row.employeeId).toBe(employeeId);
      expect(row.processedAt).not.toBeNull();
      // The simulated provider result is persisted alongside the terminal write.
      const result = row.result as
        | { reference?: string; employeeId?: string }
        | null;
      expect(result?.reference).toMatch(/^SIM-/);
      expect(result?.employeeId).toBe(employeeId);

      // R5 audit trail: the SUCCESS attempt row (attemptNumber 1 on first try)
      // commits in the SAME transaction as the event → success write and carries
      // the identical handler result.
      const attempts = await prisma.eventAttempt.findMany({
        where: { eventId: id },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        eventId: id,
        attemptNumber: 1,
        status: 'SUCCESS',
      });
      expect(attempts[0].result).toEqual(result);
    });
  });

  describe('per-employee FIFO burst', () => {
    it('drains a burst sequentially in sequence order', async () => {
      const employeeId = employee('burst');
      const keys = [key(), key(), key()];
      for (const k of keys) {
        await submit(employeeId, k);
      }

      const rows = await waitFor(async () => {
        const found = await prisma.payrollEvent.findMany({
          where: { employeeId, organizationId: tenant.organizationId },
          orderBy: { sequence: 'asc' },
        });
        return found.length === 3 && found.every((r) => r.status === 'SUCCESS')
          ? found
          : null;
      });

      // All three rows landed, right per-employee sequence ordering.
      expect(rows.map((r) => r.sequence)).toEqual([1n, 2n, 3n]);

      // FIFO: the second event is processed no earlier than the first. Because
      // the tenant-qualified `jobId` keeps one job in flight, the
      // worker relays them one at a time, so processed_at is non-decreasing in
      // sequence order.
      const processedAt = rows.map((r) => r.processedAt?.getTime() ?? -1);
      for (let i = 1; i < processedAt.length; i++) {
        expect(processedAt[i]).toBeGreaterThanOrEqual(processedAt[i - 1]);
      }
    });
  });
});