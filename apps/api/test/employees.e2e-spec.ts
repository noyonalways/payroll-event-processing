import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { DEMO_EMPLOYEE_SEEDS } from '@repo/shared';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';

/**
 * E2E for the employees directory CRUD (employee-directory). Runs against real
 * Postgres + Redis (docker compose) and exercises the exact HTTP surface: the
 * per-organization unique number as the 409 arbiter, number-ascending keyset
 * pagination, search/active filters, PATCH corrections with an immutable
 * employeeNumber, DELETE-as-archive with reserved numbers, tenant isolation
 * (cross-org reads are 404), and the demo-employee seeding every registration
 * performs (design D7).
 */
describe('Employees directory CRUD (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  let otherTenant: TestTenant;

  const suffix = Date.now();
  let seq = 0;
  /** Fresh, tenant-unique employee number within this suite. */
  const nextNumber = (label = 'e') => `${label}-${suffix}-${++seq}`;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror src/main.ts so e2e exercises the exact production pipeline
    // (whitelist + forbidNonWhitelisted is what enforces the 400s).
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
    tenant = await registerTenant(app, 'employees');
    otherTenant = await registerTenant(app, 'employees-other');
  });

  afterAll(async () => {
    await app.close();
  });

  const create = (body: object, as: TestTenant = tenant) =>
    request(app.getHttpServer())
      .post('/employees')
      .set(as.headers)
      .send(body);

  const list = (query: Record<string, string | number | boolean> = {}, as: TestTenant = tenant) =>
    request(app.getHttpServer())
      .get('/employees')
      .set(as.headers)
      .query(query);

  const getOne = (id: string, as: TestTenant = tenant) =>
    request(app.getHttpServer()).get(`/employees/${id}`).set(as.headers);

  const patchOne = (id: string, body: object, as: TestTenant = tenant) =>
    request(app.getHttpServer()).patch(`/employees/${id}`).set(as.headers).send(body);

  const del = (id: string, as: TestTenant = tenant) =>
    request(app.getHttpServer()).delete(`/employees/${id}`).set(as.headers);

  describe('POST /employees', () => {
    it('registers an employee and returns the full active representation', async () => {
      const employeeNumber = nextNumber();
      const res = await create({
        employeeNumber,
        name: 'Ada Lovelace',
        department: 'Engineering',
      }).expect(201);

      expect(res.body).toMatchObject({
        employeeNumber,
        name: 'Ada Lovelace',
        department: 'Engineering',
        active: true,
      });
      expect(typeof res.body.id).toBe('string');
      expect(res.body.createdAt).toEqual(expect.any(String));
    });

    it('rejects a duplicate employee number with 409 — including an archived one', async () => {
      const employeeNumber = nextNumber();
      await create({ employeeNumber, name: 'One' }).expect(201);
      await create({ employeeNumber, name: 'Two' }).expect(409);

      // The number stays reserved through an archive (design D5).
      const res = await list({ search: employeeNumber });
      const record = res.body.data[0];
      await del(record.id).expect(204);
      await create({ employeeNumber, name: 'Three' }).expect(409);
    });

    it('rejects missing or blank fields with a structured 400', async () => {
      const blank = await create({ employeeNumber: '   ', name: 'X' }).expect(400);
      expect(blank.body.statusCode).toBe(400);

      await create({ employeeNumber: nextNumber() }).expect(400); // no name
      await create({ name: 'No number' }).expect(400);
    });

    it('requires a token', async () => {
      await request(app.getHttpServer())
        .post('/employees')
        .send({ employeeNumber: nextNumber(), name: 'X' })
        .expect(401);
    });
  });

  describe('GET /employees', () => {
    it('orders pages by employee number ascending and walks each record exactly once', async () => {
      // Register a small alphabetical block:
      const block = ['a', 'b', 'c', 'd'].map((letter) => `block-${suffix}-${letter}`);
      for (const employeeNumber of block) {
        await create({ employeeNumber, name: `Block ${employeeNumber}` }).expect(201);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = (
          await list(cursor ? { limit: 2, cursor } : { limit: 2 }).expect(200)
        ).body as {
          data: Array<{ employeeNumber: string }>;
          nextCursor: string | null;
        };
        seen.push(...page.data.map((r: { employeeNumber: string }) => r.employeeNumber));
        const ordered = [...page.data.map((r: { employeeNumber: string }) => r.employeeNumber)];
        expect(ordered).toEqual([...ordered].sort());
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);

      // The block appears exactly once each, in number order, across pages.
      for (const n of block) {
        expect(seen.filter((num) => num === n)).toHaveLength(1);
      }
      const positions = block.map((n) => seen.indexOf(n));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('keeps pages stable while employees register between fetches', async () => {
      for (const n of ['s1', 's2']) {
        await create({ employeeNumber: `stable-${suffix}-${n}`, name: `Stable ${n}` }).expect(201);
      }
      const page1 = (await list({ search: `stable-${suffix}`, limit: 1 }).expect(200)).body;
      expect(page1.nextCursor).not.toBeNull();

      // A new registration lands BETWEEN the two page fetches…
      await create({ employeeNumber: `stable-${suffix}-s0`, name: 'Stable zero' }).expect(201);

      // …and page 2 continues page 1's position instead of shifting.
      const page2 = (await list({ search: `stable-${suffix}`, limit: 1, cursor: page1.nextCursor }).expect(200)).body;
      expect(page2.data[0].employeeNumber).toBe(`stable-${suffix}-s2`);
    });

    it('filters by search (number or name, case-insensitive) and the active flag', async () => {
      const num = nextNumber('ada');
      await create({ employeeNumber: num, name: 'ADA SECOND' }).expect(201);
      const recordId = (await list({ search: num }).expect(200)).body.data[0].id;
      await patchOne(recordId, { active: false }).expect(200);

      // Search matches the number AND the name, case-insensitively.
      const byName = await list({ search: 'ada second' }).expect(200);
      expect(byName.body.data.some((r: { id: string }) => r.id === recordId)).toBe(true);

      // The archived one disappears from active=true, appears in active=false.
      const active = await list({ search: num, active: true }).expect(200);
      expect(active.body.data).toHaveLength(0);
      const archived = await list({ search: num, active: false }).expect(200);
      expect(archived.body.data.map((r: { id: string }) => r.id)).toEqual([recordId]);
    });

    it('rejects a malformed cursor and an out-of-range page size with 400', async () => {
      await list({ cursor: '@@nope@@' }).expect(400);
      await list({ limit: 0 }).expect(400);
      await list({ limit: 101 }).expect(400);
      await list({ active: 'not-a-boolean' }).expect(400);
    });

    it('never lists another organization’s employees', async () => {
      const res = await list({ limit: 100 }, otherTenant).expect(200);
      for (const entry of res.body.data as Array<{ employeeNumber: string }>) {
        // otherTenant's rows are its own (demo + its additions) — none of
        // tenant's suite-local numbers leak, even though they exist in the DB.
        expect(entry.employeeNumber.startsWith('e-')).toBe(false);
      }
    });
  });

  describe('GET / PATCH / DELETE one employee', () => {
    it('reads, corrects in place, keeps the number immutable, and archives idempotently with history intact', async () => {
      const employeeNumber = nextNumber('life');
      const createRes = await create({ employeeNumber, name: 'Original' }).expect(201);
      const id = createRes.body.id as string;

      await getOne(id).expect(200);

      const patched = await patchOne(id, { name: 'Corrected', department: 'People' }).expect(200);
      expect(patched.body).toMatchObject({ name: 'Corrected', department: 'People' });

      // Immutable cross-reference: a PATCH carrying employeeNumber is a 400…
      const immut = await patchOne(id, { employeeNumber: nextNumber('x') }).expect(400);
      expect(immut.body.statusCode).toBe(400);
      // …and the stored number did not move.
      expect((await getOne(id).expect(200)).body.employeeNumber).toBe(employeeNumber);

      // An event for this employee exists BEFORE the archive; the archive must
      // not touch it (design D5: delete means archive, history unchanged).
      const eventKey = randomUUID();
      await request(app.getHttpServer())
        .post('/events')
        .set(tenant.headers)
        .set('Idempotency-Key', eventKey)
        .send({
          eventType: 'BANK_ACCOUNT_CHANGE',
          payload: { employeeId: employeeNumber, effectiveDate: '2026-09-01', iban: 'DE89370400440532013000' },
        })
        .expect(201);

      await del(id).expect(204);
      const archived = await getOne(id).expect(200);
      expect(archived.body.active).toBe(false);

      // DELETE is idempotent: the archived record answers 204 again.
      await del(id).expect(204);

      // …and the event submitted before the archive is unchanged.
      const events = await prisma.payrollEvent.findMany({
        where: { organizationId: tenant.organizationId, employeeId: employeeNumber },
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ employeeId: employeeNumber });
    });

    it('answers 404 for an unknown id on every route', async () => {
      const missing = randomUUID();
      await getOne(missing).expect(404);
      await patchOne(missing, { name: 'X' }).expect(404);
      await del(missing).expect(404);
    });
  });

  describe('tenant isolation', () => {
    it('treats another organization’s employee as absent on every route, without modifying it', async () => {
      const employeeNumber = nextNumber('foreign');
      const id = (await create({ employeeNumber, name: 'Stay home' }).expect(201)).body.id as string;

      await getOne(id, otherTenant).expect(404);
      await patchOne(id, { name: 'Hacked' }, otherTenant).expect(404);
      await del(id, otherTenant).expect(404);

      // Unchanged, and still only in tenant's directory.
      expect((await getOne(id).expect(200)).body).toMatchObject({
        employeeNumber,
        name: 'Stay home',
        active: true,
      });
    });
  });

  describe('demo employees (registration seeding, design D7)', () => {
    it('gives every freshly registered organization exactly the five seeded demo employees', async () => {
      // Both tenants of this suite registered through the REAL endpoint.
      for (const t of [tenant, otherTenant]) {
        const page = (await list({ active: true, limit: 100 }, t).expect(200)).body;
        const demo = (page.data as Array<{ employeeNumber: string }>)
          .filter((r) => r.employeeNumber.startsWith('EMP-DEMO-'))
          .map((r) => r.employeeNumber)
          .sort();
        expect(demo).toEqual(DEMO_EMPLOYEE_SEEDS.map((s) => s.employeeNumber).sort());
      }

      // None of the rows are shared across organizations: registration created
      // independent records for each tenant (ownership read from the store —
      // the wire representation does not carry the organization).
      const first = (await list({ search: 'EMP-DEMO-SUCCESS' }, tenant).expect(200)).body.data[0];
      const second = (await list({ search: 'EMP-DEMO-SUCCESS' }, otherTenant).expect(200)).body
        .data[0];
      expect(first.id).not.toBe(second.id);
      const firstRow = await prisma.employee.findUnique({ where: { id: first.id } });
      const secondRow = await prisma.employee.findUnique({ where: { id: second.id } });
      expect(firstRow?.organizationId).toBe(tenant.organizationId);
      expect(secondRow?.organizationId).toBe(otherTenant.organizationId);
    });

    it('seeds demo employees as submittable: an event for a seeded id passes the gate', async () => {
      await request(app.getHttpServer())
        .post('/events')
        .set(tenant.headers)
        .set('Idempotency-Key', randomUUID())
        .send({
          eventType: 'SALARY_CHANGE',
          payload: {
            employeeId: 'EMP-DEMO-RECOVER',
            effectiveDate: '2026-09-01',
            newSalary: 50_000,
            currency: 'EUR',
          },
        })
        .expect(201);
    });
  });
});
