import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../apps/worker/src/worker.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * E2E for the simulated processing failure path — REAL Postgres + REAL Redis
 * required (`docker compose up` brings up both).
 *
 * `PAYROLL_FAILURE_MODE=always-transient` is pinned before module build so the
 * simulated provider throws on every handler call, exercising the guarded
 * `processing → failed` transition and proving the failed row is terminal:
 * `result` stays NULL, `processed_at` stays NULL, and nothing re-enqueues it.
 */
jest.setTimeout(30_000);

describe('POST /events → worker failure lifecycle (e2e)', () => {
  let app: INestApplication;
  let workerApp: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    // Must be set before the worker's FailureConfig factory runs (module build).
    process.env.PAYROLL_FAILURE_MODE = 'always-transient';

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

    // Boot the real consumer so the queue is actually drained.
    const workerModuleRef: TestingModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    workerApp = workerModuleRef.createNestApplication();
    await workerApp.init();
  });

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await workerApp?.close();
    await app?.close();
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());
  const key = () => randomUUID();
  const employee = (prefix: string) => `${prefix}-${randomUUID()}`;

  /** Polls Postgres until `predicate` returns a truthy value or the deadline hits. */
  const waitFor = async <T>(
    predicate: () => Promise<T | null>,
    // 25 s: the default retry cadence (5 attempts, exponential backoff, 1 s base)
    // takes ~16 s from submission for the row to reach `failed`; a 15 s wall
    // races it and flakes.
    { timeout = 25_000, interval = 50 } = {},
  ): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('Timed out waiting for the worker pipeline');
  };

  it('a simulated failure transitions the row to failed with no result and no re-enqueue', async () => {
    const employeeId = employee('fail');
    const idempotencyKey = key();
    const id = (
      await http()
        .post('/events')
        .set('Idempotency-Key', idempotencyKey)
        .send({
          eventType: 'SALARY_CHANGE',
          payload: {
            employeeId,
            effectiveDate: '2026-09-01',
            newSalary: 75000,
            currency: 'EUR',
          },
        })
        .expect(201)
    ).body.id as string;

    const row = await waitFor(async () => {
      const found = await prisma.payrollEvent.findUnique({ where: { id } });
      return found?.status === 'FAILED' ? found : null;
    });

    expect(row.status).toBe('FAILED');
    expect(row.result).toBeNull();
    expect(row.processedAt).toBeNull();

    // No re-enqueue loop: once FAILED the row is terminal — it must not flip
    // back to processing/success (the relay only picks non-terminal rows).
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await prisma.payrollEvent.findUnique({ where: { id } });
    expect(after?.status).toBe('FAILED');
    expect(after?.result).toBeNull();
  });
});