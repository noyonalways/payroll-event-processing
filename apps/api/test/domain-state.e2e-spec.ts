import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import {
  AppModule,
  EventClaim,
  HttpExceptionFilter,
  ProcessingModule,
  WorkerModule,
} from '@repo/core';
import { PrismaService } from '@repo/database';
import { TestTenant, registerTenant } from './support/auth';

/**
 * E2E for the domain state write path (domain-effects) — REAL Postgres + REAL
 * Redis required (`docker compose up` brings up both, plus pending migrations).
 *
 * Employee ids: submission validates `employeeId` against the organization's
 * `employees` directory (employee-directory change), so every suite employee is
 * one of the five reserved `EMP-DEMO-` scenario numbers — seeded below exactly
 * like registration does (employee-directory `DEMO_EMPLOYEE_SEEDS`; the list
 * here must stay in sync with it). The demo lever also makes these ids
 * deterministic for the PROCESSING side: `EMP-DEMO-SUCCESS` always succeeds on
 * attempt 1, `EMP-DEMO-RECOVER` fails transiently on attempts 1–2 and succeeds
 * on attempt 3, `EMP-DEMO-PERMANENT` rejects permanently on attempt 1 — all
 * regardless of `PAYROLL_FAILURE_MODE`, which the suite pins to
 * `always-success` before module build so non-scenario paths stay deterministic.
 *
 * Two disjoint describe blocks keep the claim races honest:
 *  - the FIRST boots the real worker, so submitted events actually drain and
 *    the persisted state timelines are asserted end to end;
 *  - the SECOND runs API-only (no worker, and the first block's worker is long
 *    closed by the time it runs), so an event stays `queued` and `EventClaim`
 *    can be driven directly: concurrent claim attempts of one event, and a job
 *    naming a foreign organization's event. Under the guarded claim, EITHER
 *    interleaving yields exactly one state row — no timing assumptions.
 *
 * Every assertion is scoped to the submitting tenant's organization and the
 * event's id, so the suite runs repeatedly against the same database.
 */
jest.setTimeout(30_000);

/** The five reserved scenario employee numbers — must match
 * `DEMO_EMPLOYEE_SEEDS` in `@repo/shared` (employee-directory seeding). */
const DEMO_EMPLOYEE_SEEDS = [
  { employeeNumber: 'EMP-DEMO-SUCCESS', name: 'Demo employee (success)' },
  { employeeNumber: 'EMP-DEMO-RECOVER', name: 'Demo employee (recover)' },
  { employeeNumber: 'EMP-DEMO-TRANSIENT', name: 'Demo employee (transient)' },
  { employeeNumber: 'EMP-DEMO-FAILAFTER', name: 'Demo employee (fail-after-retries)' },
  { employeeNumber: 'EMP-DEMO-PERMANENT', name: 'Demo employee (permanent)' },
];
const DEMO_EMPLOYEE_DEPARTMENT = 'Demo';

/** The always-succeeds-on-attempt-1 scenario employee. */
const SUCCESS_EMPLOYEE = 'EMP-DEMO-SUCCESS';

/**
 * Seeds the reserved scenario employees for an organization, exactly like
 * registration does (employee-directory). `skipDuplicates` makes this a no-op
 * whenever registration already seeded them, so the suite is agnostic to that
 * change having landed or not.
 */
const seedScenarioEmployees = (prisma: PrismaService, tenant: TestTenant) =>
  prisma.employee.createMany({
    data: DEMO_EMPLOYEE_SEEDS.map((seed) => ({
      organizationId: tenant.organizationId,
      employeeNumber: seed.employeeNumber,
      name: seed.name,
      department: DEMO_EMPLOYEE_DEPARTMENT,
      active: true,
    })),
    skipDuplicates: true,
  });

/** Shared submit helper: real authenticated POST /events with a fresh key. */
const submit = (
  app: INestApplication,
  tenant: TestTenant,
  body: Record<string, unknown>,
) =>
  request(app.getHttpServer())
    .post('/events')
    .set(tenant.headers)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(201);

const salaryPayload = (employeeId: string, effectiveDate = '2026-09-01') => ({
  eventType: 'SALARY_CHANGE',
  payload: { employeeId, effectiveDate, newSalary: 75000, currency: 'EUR' },
});

const bankPayload = (employeeId: string) => ({
  eventType: 'BANK_ACCOUNT_CHANGE',
  payload: { employeeId, effectiveDate: '2026-10-01', iban: 'DE89370400440532013000' },
});

const addressPayload = (employeeId: string) => ({
  eventType: 'ADDRESS_CHANGE',
  payload: {
    employeeId,
    effectiveDate: '2026-09-15',
    street: 'Main St',
    city: 'Berlin',
    postalCode: '10115',
    country: 'DE',
  },
});

const departmentPayload = (employeeId: string) => ({
  eventType: 'DEPARTMENT_CHANGE',
  payload: {
    employeeId,
    effectiveDate: '2026-11-01',
    newDepartment: 'Engineering',
  },
});

describe('domain state — drained through the worker (e2e)', () => {
  let app: INestApplication;
  let workerApp: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;

  beforeAll(async () => {
    // Must be set before the worker's FailureConfig factory runs (module build).
    process.env.PAYROLL_FAILURE_MODE = 'always-success';

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
    tenant = await registerTenant(app, 'domain-state');
    await seedScenarioEmployees(prisma, tenant);

    // Boot the real consumer so submissions actually drain to success.
    const workerModuleRef: TestingModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    workerApp = workerModuleRef.createNestApplication();
    await workerApp.init();
  });

  beforeEach(async () => {
    await prisma.employeeDomainState.deleteMany({});
    await prisma.payrollEvent.deleteMany({});
    await prisma.eventAttempt.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await workerApp?.close();
    await app?.close();
    await prisma.employeeDomainState.deleteMany({}).catch(() => undefined);
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await prisma.eventAttempt.deleteMany({}).catch(() => undefined);
  });

  /** Polls Postgres until the event row reaches one of the given statuses. */
  const waitForStatus = async (
    id: string,
    statuses: readonly ('QUEUED' | 'SUCCESS' | 'FAILED')[],
  ) => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const found = await prisma.payrollEvent.findFirst({
        where: { id, organizationId: tenant.organizationId },
      });
      if (found && (statuses as readonly string[]).includes(found.status)) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for the event to reach ${statuses.join('/')}`);
  };

  const stateRows = (eventId: string) =>
    prisma.employeeDomainState.findMany({ where: { sourceEventId: eventId } });

  it('each successfully processed event type persists exactly one fully-attributed state row', async () => {
    const submitted = await Promise.all([
      submit(app, tenant, salaryPayload(SUCCESS_EMPLOYEE)),
      submit(app, tenant, bankPayload(SUCCESS_EMPLOYEE)),
      submit(app, tenant, addressPayload(SUCCESS_EMPLOYEE)),
      submit(app, tenant, departmentPayload(SUCCESS_EMPLOYEE)),
    ]);
    const ids = submitted.map((res) => res.body.id as string);
    await Promise.all(ids.map((id) => waitForStatus(id, ['SUCCESS'])));

    // One state row per event — no event of the four left without state, none
    // with a duplicate (UNIQUE source_event_id).
    const [salary, bank, address, department] = await Promise.all(
      ids.map((id) => stateRows(id)),
    );

    expect(salary).toHaveLength(1);
    expect(salary[0]).toMatchObject({
      organizationId: tenant.organizationId,
      employeeId: SUCCESS_EMPLOYEE,
      domain: 'COMPENSATION',
      value: { newSalary: 75000, currency: 'EUR' },
      sourceEventId: ids[0],
    });
    expect(salary[0]!.effectiveDate.toISOString().slice(0, 10)).toBe('2026-09-01');

    expect(bank).toHaveLength(1);
    expect(bank[0]).toMatchObject({
      organizationId: tenant.organizationId,
      employeeId: SUCCESS_EMPLOYEE,
      domain: 'BANK_ACCOUNT',
      value: { iban: 'DE89370400440532013000' },
      sourceEventId: ids[1],
    });
    expect(bank[0]!.effectiveDate.toISOString().slice(0, 10)).toBe('2026-10-01');

    expect(address).toHaveLength(1);
    expect(address[0]).toMatchObject({
      organizationId: tenant.organizationId,
      employeeId: SUCCESS_EMPLOYEE,
      domain: 'ADDRESS',
      value: {
        street: 'Main St',
        city: 'Berlin',
        postalCode: '10115',
        country: 'DE',
      },
      sourceEventId: ids[2],
    });

    expect(department).toHaveLength(1);
    expect(department[0]).toMatchObject({
      organizationId: tenant.organizationId,
      employeeId: SUCCESS_EMPLOYEE,
      domain: 'DEPARTMENT',
      value: { newDepartment: 'Engineering' },
      sourceEventId: ids[3],
    });
  });

  it('accumulates the effective-dated timeline per employee instead of overwriting it', async () => {
    // Timeline accumulates per employee: two changes for the same reserved id.
    const january = await submit(
      app,
      tenant,
      salaryPayload(SUCCESS_EMPLOYEE, '2026-01-01'),
    );
    const june = await submit(app, tenant, salaryPayload(SUCCESS_EMPLOYEE, '2026-06-01'));
    await Promise.all([
      waitForStatus(january.body.id, ['SUCCESS']),
      waitForStatus(june.body.id, ['SUCCESS']),
    ]);

    const timeline = await prisma.employeeDomainState.findMany({
      where: { organizationId: tenant.organizationId, employeeId: SUCCESS_EMPLOYEE, domain: 'COMPENSATION' },
      orderBy: { effectiveDate: 'desc' },
    });

    expect(timeline).toHaveLength(2);
    expect(timeline[0]!.sourceEventId).toBe(june.body.id);
    expect(timeline[0]!.effectiveDate.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(timeline[1]!.effectiveDate.toISOString().slice(0, 10)).toBe('2026-01-01');
    // Submitting tenant reads both changes back independently — the January
    // row is untouched by the June event (append-only, never overwritten).
    expect(timeline[0]!.value).toEqual({ newSalary: 75000, currency: 'EUR' });
    expect(timeline[1]!.value).toEqual({ newSalary: 75000, currency: 'EUR' });
  });

  it('a transient-failure-then-success event leaves exactly one state row (RECOVER)', async () => {
    // The demo lever forces transient failures on attempts 1-2 and success on
    // attempt 3 regardless of the env mode — the failed attempts write nothing,
    // the successful attempt writes exactly one row.
    const submitted = await submit(
      app,
      tenant,
      salaryPayload('EMP-DEMO-RECOVER'),
    );
    const row = await waitForStatus(submitted.body.id, ['SUCCESS']);

    const rows = await stateRows(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: tenant.organizationId,
      employeeId: 'EMP-DEMO-RECOVER',
      domain: 'COMPENSATION',
      value: { newSalary: 75000, currency: 'EUR' },
      sourceEventId: row.id,
    });
  });

  it('a permanently failed event leaves zero state rows (EMP-DEMO-PERMANENT)', async () => {
    const submitted = await submit(
      app,
      tenant,
      salaryPayload('EMP-DEMO-PERMANENT'),
    );
    const row = await waitForStatus(submitted.body.id, ['FAILED']);

    expect(await stateRows(row.id)).toHaveLength(0);
    // The whole employee's state space stays empty — a permanent failure never
    // half-applies its change.
    expect(
      await prisma.employeeDomainState.count({
        where: { organizationId: tenant.organizationId, employeeId: 'EMP-DEMO-PERMANENT' },
      }),
    ).toBe(0);
  });

  it('the same employee id in two organizations keeps two independent timelines', async () => {
    const other = await registerTenant(app, 'domain-state-b');
    await seedScenarioEmployees(prisma, other);
    // The same reserved employee number, legitimately present in BOTH
    // organizations’ directories — tenant locality is the isolation subject.
    const shared = SUCCESS_EMPLOYEE;

    const a = await submit(app, tenant, bankPayload(shared));
    const b = await submit(app, other, bankPayload(shared));
    await Promise.all([
      waitForStatus(a.body.id, ['SUCCESS']),
      (async () => {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          const found = await prisma.payrollEvent.findFirst({
            where: { id: b.body.id, organizationId: other.organizationId },
          });
          if (found?.status === 'SUCCESS') return found;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Timed out waiting for tenant B event');
      })(),
    ]);

    const aRows = await prisma.employeeDomainState.findMany({
      where: { organizationId: tenant.organizationId, employeeId: shared },
    });
    const bRows = await prisma.employeeDomainState.findMany({
      where: { organizationId: other.organizationId, employeeId: shared },
    });

    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0]!.organizationId).toBe(tenant.organizationId);
    expect(bRows[0]!.organizationId).toBe(other.organizationId);
    expect(aRows[0]!.sourceEventId).toBe(a.body.id);
    expect(bRows[0]!.sourceEventId).toBe(b.body.id);
  });
});

describe('domain state — direct claim races, no worker (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    process.env.PAYROLL_FAILURE_MODE = 'always-success';

    // API-only: no WorkerModule, so nothing drains the queue and an event
    // stays exactly where direct claimAndProcess calls expect it.
    // ProcessingModule is imported directly because the API composition root
    // does not include it — EventClaim (and the state writer) live in the
    // processing module shared with the worker.
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule, ProcessingModule],
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
    tenantA = await registerTenant(app, 'claim-race-a');
    tenantB = await registerTenant(app, 'claim-race-b');
    await seedScenarioEmployees(prisma, tenantA);
    await seedScenarioEmployees(prisma, tenantB);
  });

  beforeEach(async () => {
    await prisma.employeeDomainState.deleteMany({});
    await prisma.payrollEvent.deleteMany({});
    await prisma.eventAttempt.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await app?.close();
    await prisma.employeeDomainState.deleteMany({}).catch(() => undefined);
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await prisma.eventAttempt.deleteMany({}).catch(() => undefined);
  });

  /** Waits until the submitted event is claimed-able (`queued`). */
  const waitForQueued = async (id: string, organizationId: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = await prisma.payrollEvent.findFirst({
        where: { id, organizationId },
      });
      if (found?.status === 'QUEUED') return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for the event to reach queued');
  };

  const claimInput = (row: { id: string; organizationId: string; eventType: string; employeeId: string; sequence: bigint }) => ({
    eventId: row.id,
    organizationId: row.organizationId,
    eventType: row.eventType,
    employeeId: row.employeeId,
    sequence: Number(row.sequence),
    attempt: 1,
  });

  it('two concurrent claim attempts of one event yield exactly one state row', async () => {
    const submitted = await submit(app, tenantA, salaryPayload(SUCCESS_EMPLOYEE));
    const row = await waitForQueued(submitted.body.id, tenantA.organizationId);
    const eventClaim = app.get(EventClaim);
    const input = claimInput(row);

    const [first, second] = await Promise.all([
      eventClaim.claimAndProcess(input),
      eventClaim.claimAndProcess(input),
    ]);

    // One claim wins, the contender sees the claimed/terminal row and skips —
    // either arrival order, no timing assumptions.
    expect([first.outcome, second.outcome].sort()).toEqual(['skipped', 'success']);

    const rows = await prisma.employeeDomainState.findMany({
      where: { sourceEventId: row.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: tenantA.organizationId,
      employeeId: row.employeeId,
      domain: 'COMPENSATION',
    });
    const after = await prisma.payrollEvent.findFirst({
      where: { id: row.id, organizationId: tenantA.organizationId },
    });
    expect(after?.status).toBe('SUCCESS');
  });

  it('a job naming a foreign organization’s event writes nothing; the rightful claim still succeeds', async () => {
    const submitted = await submit(app, tenantA, salaryPayload(SUCCESS_EMPLOYEE));
    const row = await waitForQueued(submitted.body.id, tenantA.organizationId);
    const eventClaim = app.get(EventClaim);

    // The event id is real, but the job carries tenant B's organization: the
    // tenant-scoped claim matches no row and no side effect may occur.
    const foreign = await eventClaim.claimAndProcess({
      eventId: row.id,
      organizationId: tenantB.organizationId,
      eventType: row.eventType,
      employeeId: row.employeeId,
      sequence: Number(row.sequence),
      attempt: 1,
    });
    expect(foreign).toEqual({ outcome: 'skipped' });
    // Zero rows anywhere for this event after the rejected claim.
    expect(await prisma.employeeDomainState.count({ where: { sourceEventId: row.id } })).toBe(0);
    expect(await prisma.employeeDomainState.count({ where: { organizationId: tenantB.organizationId } })).toBe(0);
    // The row is untouched and still claimable by the rightful organization.
    const still = await prisma.payrollEvent.findFirst({
      where: { id: row.id, organizationId: tenantA.organizationId },
    });
    expect(still?.status).toBe('QUEUED');

    const rightful = await eventClaim.claimAndProcess({
      eventId: row.id,
      organizationId: tenantA.organizationId,
      eventType: row.eventType,
      employeeId: row.employeeId,
      sequence: Number(row.sequence),
      attempt: 1,
    });
    expect(rightful).toEqual({ outcome: 'success', reference: expect.any(String) });

    const rows = await prisma.employeeDomainState.findMany({
      where: { sourceEventId: row.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizationId).toBe(tenantA.organizationId);
  });
});
