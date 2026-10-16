import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';
import { ensureEmployee, seedEmployeePool } from './support/directory';

/**
 * E2E for the submission-side employee-directory gate (employee-directory,
 * design D3): `POST /events` accepts a payload employeeId only when an ACTIVE
 * employee with that number exists in the CALLER's organization. Runs against
 * real Postgres + Redis (docker compose).
 *
 * The gate is a BUSINESS validation (reliability R1's permanent class): it
 * never reaches the queue, and it fires before the idempotency layer (R2), so
 * a rejected attempt consumes no Idempotency-Key.
 */
describe('POST /events employee-directory gate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;

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
    tenant = await registerTenant(app, 'gate');

    // Wiring for the free-form fixture era: a small pool of valid employees
    // for the positive paths.
    employee = await seedEmployeePool(prisma, tenant.organizationId, 'gate', 8, 'ok');
  });

  let employee: () => string;

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({ where: { organizationId: tenant.organizationId } });
    await prisma.idempotencyRecord.deleteMany({ where: { organizationId: tenant.organizationId } });
  });

  afterAll(async () => {
    // Cascade-friendly teardown of THIS tenant only: recovery rows cascade
    // with the events; the demo employees this tenant's registration seeded
    // go with the org when the suites finally drop it (suite-local tenant).
    await prisma.payrollEvent.deleteMany({ where: { organizationId: tenant.organizationId } }).catch(() => undefined);
    await prisma.idempotencyRecord.deleteMany({ where: { organizationId: tenant.organizationId } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { organizationId: tenant.organizationId } }).catch(() => undefined);
    await app.close();
  });

  const submit = () => request(app.getHttpServer()).post('/events').set(tenant.headers);
  const key = () => randomUUID();

  const salaryChange = (employeeId: string) => ({
    eventType: 'SALARY_CHANGE',
    payload: {
      employeeId,
      effectiveDate: '2026-09-01',
      newSalary: 75_000,
      currency: 'EUR',
    },
  });

  it('accepts a submission for an active directory employee (201, stored, sequence 1)', async () => {
    const res = await submit()
      .set('Idempotency-Key', key())
      .send(salaryChange(employee()))
      .expect(201);

    expect(res.body).toMatchObject({ status: 'received' });
    const row = await prisma.payrollEvent.findFirst({
      where: { organizationId: tenant.organizationId },
    });
    expect(row).not.toBeNull();
    expect(row?.sequence.toString()).toBe('1');
  });

  it('rejects an unknown employee with a structured 422 naming employeeId, and persists nothing', async () => {
    const unknown = `ghost-${randomUUID()}`;
    const res = await submit()
      .set('Idempotency-Key', key())
      .send(salaryChange(unknown))
      .expect(422);

    expect(res.body).toMatchObject({ statusCode: 422, error: 'UnprocessableEntityException' });
    expect(String(res.body.message)).toContain('employeeId');
    expect(String(res.body.message)).toContain(unknown);
    expect(await prisma.payrollEvent.count({ where: { organizationId: tenant.organizationId } })).toBe(0);
    // R1's permanent class in evidence: nothing enqueued-side exists either —
    // no idempotency record was written by the rejected attempt.
    expect(await prisma.idempotencyRecord.count({ where: { organizationId: tenant.organizationId } })).toBe(0);
  });

  it('rejects an archived employee with the same 422', async () => {
    const number = employee();
    await ensureEmployee(prisma, tenant.organizationId, number);

    const before = await submit()
      .set('Idempotency-Key', key())
      .send(salaryChange(number))
      .expect(201);

    await prisma.employee.updateMany({
      where: { organizationId: tenant.organizationId, employeeNumber: number },
      data: { active: false },
    });

    await submit()
      .set('Idempotency-Key', key())
      .send(salaryChange(number))
      .expect(422);

    // The earlier event and its history are untouched by the rejection: it
    // still exists, accepted for the same number, on its normal lifecycle
    // (a 201 submission is marked queued immediately after commit).
    const row = await prisma.payrollEvent.findUnique({ where: { id: before.body.id } });
    expect(row?.status).toBe('QUEUED');
    expect(row?.employeeId).toBe(number);
  });

  it('keeps the same employee number independent in two organizations (each accepted, own sequence)', async () => {
    const other = await registerTenant(app, 'gate-other');
    const shared = `shared-${randomUUID()}`;
    await ensureEmployee(prisma, tenant.organizationId, shared);
    await ensureEmployee(prisma, other.organizationId, shared);

    await submit().set('Idempotency-Key', key()).send(salaryChange(shared)).expect(201);
    await request(app.getHttpServer())
      .post('/events')
      .set(other.headers)
      .set('Idempotency-Key', key())
      .send(salaryChange(shared))
      .expect(201);

    for (const t of [tenant, other]) {
      const row = await prisma.payrollEvent.findFirst({
        where: { organizationId: t.organizationId, employeeId: shared },
      });
      expect(row?.sequence.toString()).toBe('1');
    }
    // Tenant B's directory never gates tenant A's number.
    await request(app.getHttpServer())
      .post('/events')
      .set(other.headers)
      .set('Idempotency-Key', key())
      .send(salaryChange(employee()))
      .expect(422);
  });

  it('accepts the seeded EMP-DEMO-RECOVER employee like any other directory row', async () => {
    // Registration seeds the five demo employees once auth seeding is in
    // place; ensure-if-missing keeps this honest either way (the referenced
    // row must simply EXIST and be active, like any directory employee).
    await ensureEmployee(prisma, tenant.organizationId, 'EMP-DEMO-RECOVER');

    await submit()
      .set('Idempotency-Key', key())
      .send(salaryChange('EMP-DEMO-RECOVER'))
      .expect(201);
  });

  it('does not consume the Idempotency-Key: a 422 then a registration, resubmit with the same key creates the event', async () => {
    const k = key();
    const unknown = `later-${randomUUID()}`;

    await submit().set('Idempotency-Key', k).send(salaryChange(unknown)).expect(422);
    expect(
      await prisma.idempotencyRecord.count({
        where: { organizationId: tenant.organizationId },
      }),
    ).toBe(0);

    await ensureEmployee(prisma, tenant.organizationId, unknown);
    const res = await submit().set('Idempotency-Key', k).send(salaryChange(unknown)).expect(201);

    expect(res.body).toMatchObject({ status: 'received' });
    const events = await prisma.payrollEvent.findMany({
      where: { organizationId: tenant.organizationId, idempotencyKey: k },
    });
    expect(events).toHaveLength(1);
    // The accepted submission is now the key's stored (replayable) response.
    const record = await prisma.idempotencyRecord.findFirst({
      where: { organizationId: tenant.organizationId },
    });
    expect(record?.responseStatus).toBe(201);
  });
});
