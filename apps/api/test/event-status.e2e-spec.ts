import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AttemptErrorType, AttemptStatus } from '@prisma/client';
import { AppModule, HttpExceptionFilter, setupSwagger, WorkerModule } from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';
import { DirectoryEmployees } from './support/directory';

/**
 * E2E for the read-only status surface of GET /events/:id (event-status-api) —
 * REAL Postgres + REAL Redis required (`docker compose up`).
 *
 * Both payroll routes are tenant-scoped, so every boot that submits or reads an
 * event registers a real organization through the HTTP surface and attaches its
 * token to the request — the same path a client takes.
 *
 * Three boot environments in ONE file (jest runs describes in order, and
 * `test/jest-e2e.json` pins `maxWorkers: 1` so the shared Postgres is never
 * touched concurrently):
 *   1. always-transient worker — the retry cadence's backoff windows make the
 *      `queued` + non-empty FAILED(TEMPORARY) trail snapshot deterministic
 *      (the spec's own "Polling a transiently failing event returns queued
 *      between attempts"), exhaustion yields the `failed` terminal + one
 *      FAILED row per attempt, and a seeded multi-attempt trail exercises the
 *      ascending-order contract.
 *   2. always-success worker — the `success` response with processedAt/result
 *      and the SUCCESS attempt matching the committed row.
 *   3. API-only app + setupSwagger — the api-documentation delta for
 *      /api-docs-json paths and schemas.
 *
 * The failure mode env var is pinned before each module build and may not be
 * swapped inside a booted worker (FailureConfig reads it at construction).
 */
jest.setTimeout(30_000);

interface StatusBody {
  id: string;
  eventType: string;
  employeeId: string;
  sequence: number;
  status: string;
  payload: { [key: string]: unknown };
  processedAt: string | null;
  result: { [key: string]: unknown } | null;
  attempts: Array<{
    attemptNumber: number;
    status: string;
    errorType: string | null;
    failedReason: string | null;
    result: { [key: string]: unknown } | null;
    createdAt: string;
  }>;
}

const SALARY_PAYLOAD = (employeeId: string) => ({
  employeeId,
  effectiveDate: '2026-09-01',
  newSalary: 75000,
  currency: 'EUR',
});

const BANK_PAYLOAD = (employeeId: string) => ({
  employeeId,
  effectiveDate: '2026-09-01',
  iban: 'DE89370400440532013000',
});

describe('GET /events/:id — queued, failed, ordering, 404 (event-status-api, always-transient)', () => {
  let app: INestApplication;
  let workerApp: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  let employees: DirectoryEmployees;

  beforeAll(async () => {
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
    tenant = await registerTenant(app, 'event-status-transient');
    employees = new DirectoryEmployees(prisma, tenant.organizationId);
    await employees.seed('queued', 3);
    await employees.seed('failed', 3);
    await employees.seed('ordered', 3);

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
    await prisma.workerHeartbeat.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());
  const key = () => randomUUID();
  // GET /events/:id requires the tenant's bearer token — every status read and
  // submission below carries it.
  const getStatus = (id: string) =>
    http().get(`/events/${id}`).set(tenant.headers).expect(200) as Promise<request.Response>;

  const submitSalary = async (employeeId: string) =>
    http()
      .post('/events')
      .set(tenant.headers)
      .set('Idempotency-Key', key())
      .send({ eventType: 'SALARY_CHANGE', payload: SALARY_PAYLOAD(employeeId) })
      .expect(201);

  /** Polls GET /events/:id until `predicate` accepts the status body. */
  const waitForStatus = async <T>(
    id: string,
    predicate: (body: StatusBody) => T | null | undefined,
    { timeout = 25_000, interval = 50 } = {},
  ): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const body = (await getStatus(id)).body as StatusBody;
      const value = predicate(body);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('Timed out polling GET /events/:id');
  };

  it('returns the retried lifecycle state with a non-empty FAILED trail (queued scenario)', async () => {
    const employeeId = employees.draw('queued');
    const id = (await submitSalary(employeeId)).body.id as string;
    const payload = SALARY_PAYLOAD(employeeId);

    // Deterministic: between BullMQ retry attempts the claim is rolled back to
    // `queued` and the attempts that HAVE run are already on the audit trail —
    // the spec's own "returns queued between attempts" scenario. Polling until
    // that snapshot is reached is exact, not a timing race.
    const body = await waitForStatus(
      id,
      (b) => (b.status === 'queued' && b.attempts.length >= 1 ? b : null),
    );

    expect(body.id).toBe(id);
    expect(body.status).toBe('queued');
    expect(typeof body.sequence).toBe('number');
    expect(body.eventType).toBe('SALARY_CHANGE');
    expect(body.employeeId).toBe(employeeId);
    expect(body.payload).toEqual(payload);
    expect(body.processedAt).toBeNull();
    expect(body.result).toBeNull();

    // The first attempt already ran and failed transiently; the event is back
    // in `queued` waiting for the next retry.
    expect(body.attempts[0]).toMatchObject({
      attemptNumber: 1,
      status: 'FAILED',
      errorType: 'TEMPORARY',
      result: null,
    });
    expect(body.attempts[0].failedReason).toContain(
      'Simulated payroll service unavailable',
    );
  });

  it('returns the failed terminal state with one FAILED row per attempt (failed scenario)', async () => {
    const employeeId = employees.draw('failed');
    const id = (await submitSalary(employeeId)).body.id as string;

    // 5 attempts, exponential backoff from a 1 s base → exhausted in ~16 s.
    const body = await waitForStatus(id, (b) => (b.status === 'failed' ? b : null));

    expect(body.id).toBe(id);
    expect(body.status).toBe('failed');
    expect(body.processedAt).toBeNull();
    expect(body.result).toBeNull();

    // Terminal status matches the attempt trail: every transient attempt is
    // recorded, so the exhausted event shows FAILED(TEMPORARY) at attempts 1–5,
    // with the provider's failure message on the final attempt.
    expect(body.attempts).toHaveLength(5);
    body.attempts.forEach((attempt, index) => {
      expect(attempt).toMatchObject({
        attemptNumber: index + 1,
        status: 'FAILED',
        errorType: 'TEMPORARY',
        result: null,
      });
    });
    expect(body.attempts[4].failedReason).toContain(
      'Simulated payroll service unavailable',
    );
  });

  it('returns attempts ordered ascending by attemptNumber on a multi-attempt trail', async () => {
    const employeeId = employees.draw('ordered');
    const id = (await submitSalary(employeeId)).body.id as string;

    // Let the event exhaust first: the worker appends FAILED(TEMPORARY) rows
    // for attempts 1..5, and once `failed` no further rows can be written.
    await waitForStatus(id, (b) => (b.status === 'failed' ? b : null));

    // Then seed rows the worker will never touch (attempt numbers past the 5
    // configured attempts), inserted OUT of numeric order — the boundary must
    // re-sort them alongside the worker's own trail.
    await prisma.eventAttempt.create({
      data: {
        eventId: id,
        attemptNumber: 9,
        status: AttemptStatus.FAILED,
        errorType: AttemptErrorType.PERMANENT,
        failedReason: 'seeded-9',
      },
    });
    await prisma.eventAttempt.create({
      data: {
        eventId: id,
        attemptNumber: 7,
        status: AttemptStatus.FAILED,
        errorType: AttemptErrorType.PERMANENT,
        failedReason: 'seeded-7',
      },
    });

    const body = (await getStatus(id)).body as StatusBody;

    const numbers = body.attempts.map((a) => a.attemptNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 7, 9]);
    // The boundary re-sorted the out-of-order inserts alongside the worker's
    // exhausted transient trail (attempts 1–5 are all FAILED/TEMPORARY).
    expect(body.attempts.find((a) => a.attemptNumber === 7)!.failedReason).toBe(
      'seeded-7',
    );
    expect(body.attempts.find((a) => a.attemptNumber === 9)!.failedReason).toBe(
      'seeded-9',
    );
  });

  it('returns the structured 404 for an unknown id (no mutation)', async () => {
    const id = key();

    const res = await http().get(`/events/${id}`).set(tenant.headers).expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'NotFoundException',
      path: `/events/${id}`,
    });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message).toContain(id);
    expect(typeof res.body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);

    // The failed read created no rows.
    expect(await prisma.payrollEvent.findUnique({ where: { id } })).toBeNull();
  });
});

describe('GET /events/:id — successful lifecycle (event-status-api, always-success)', () => {
  let app: INestApplication;
  let workerApp: INestApplication;
  let prisma: PrismaService;
  let employees: DirectoryEmployees;
  let tenant: TestTenant;

  beforeAll(async () => {
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
    tenant = await registerTenant(app, 'event-status-success');
    employees = new DirectoryEmployees(prisma, tenant.organizationId);
    await employees.seed('success', 3);

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
    await prisma.workerHeartbeat.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());

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
    throw new Error('Timed out waiting for the success response');
  };

  it('returns success with processedAt/result and a SUCCESS attempt matching the committed row', async () => {
    const employeeId = employees.draw('success');
    const id = (
      await http()
        .post('/events')
        .set(tenant.headers)
        .set('Idempotency-Key', randomUUID())
        .send({ eventType: 'BANK_ACCOUNT_CHANGE', payload: BANK_PAYLOAD(employeeId) })
        .expect(201)
    ).body.id as string;

    const body = await waitFor(async () => {
      const res = await http().get(`/events/${id}`).set(tenant.headers);
      if (res.status !== 200) return null;
      const body = res.body as StatusBody;
      return body.status === 'success' ? body : null;
    });

    // Scoped to the submitting tenant: the committed row this assertion reads
    // can only be the one its own submission created.
    const row = await prisma.payrollEvent.findFirst({
      where: { id, organizationId: tenant.organizationId },
    });
    expect(row).not.toBeNull();

    expect(body.status).toBe('success');
    expect(body.sequence).toBe(Number(row?.sequence));
    expect(body.processedAt).not.toBeNull();
    expect(typeof body.processedAt).toBe('string');

    // The response's result is the handler's stored result, verbatim.
    expect(body.result).toEqual(row?.result as Record<string, unknown>);

    // SUCCESS attempt wrote once, on the attempt that succeeded (first try
    // under always-success), carrying the identical result.
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]).toMatchObject({
      attemptNumber: 1,
      status: 'SUCCESS',
      errorType: null,
      failedReason: null,
    });
    expect(body.attempts[0].result).toEqual(row?.result as Record<string, unknown>);
  });
});

describe('OpenAPI docs for GET /events/{id} (api-documentation delta)', () => {
  let app: INestApplication;

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
    setupSwagger(app, 3000);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('documents /events/{id} with the typed response and attempt schema', async () => {
    const doc = (await http().get('/api-docs-json').expect(200)).body;

    // api-documentation delta: all core paths are present.
    expect(doc.paths['/events']).toBeDefined();
    expect(doc.paths['/health']).toBeDefined();

    const path = doc.paths['/events/{id}'];
    expect(path.get).toBeDefined();
    expect(path.get.parameters.map((p: { name: string }) => p.name)).toContain('id');
    expect(
      path.get.responses['200'].content['application/json'].schema['$ref'],
    ).toContain('EventStatusResponseDto');
    expect(
      path.get.responses['404'].content['application/json'].schema['$ref'],
    ).toContain('ErrorResponseDto');

    const statusSchema = doc.components.schemas['EventStatusResponseDto'];
    expect(statusSchema).toBeDefined();
    for (const key of [
      'id',
      'eventType',
      'employeeId',
      'sequence',
      'status',
      'payload',
      'createdAt',
      'updatedAt',
      'processedAt',
      'result',
      'attempts',
    ]) {
      expect(statusSchema.properties[key]).toBeDefined();
    }
    expect(statusSchema.properties.attempts.type).toBe('array');
    expect(statusSchema.properties.attempts.items['$ref']).toContain(
      'EventAttemptDto',
    );

    const attemptSchema = doc.components.schemas['EventAttemptDto'];
    expect(attemptSchema).toBeDefined();
    for (const key of [
      'attemptNumber',
      'status',
      'errorType',
      'failedReason',
      'result',
      'createdAt',
    ]) {
      expect(attemptSchema.properties[key]).toBeDefined();
    }
  });
});