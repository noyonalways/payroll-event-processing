import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '@repo/core';
import { DEMO_EMPLOYEE_SEEDS } from '@repo/shared';
import { PrismaService } from '@repo/database';

/**
 * Integration coverage for the `employee-directory` migration: asserts the
 * `employees` table's shape in a REAL Postgres (docker compose), and exercises
 * the migration's two backfill statements (design D8) —
 *
 *   (b) adopting the employee ids history already uses (name unknown ⇒ NULL),
 *   (c) seeding the five reserved `EMP-DEMO-*` scenario employees,
 *
 * against an organization whose event history includes a demo id. The
 * statements are re-executed here exactly as the migration carries them (keep
 * in sync with migration 20261016000000_employee_directory) — that IS their
 * contract: the NOT EXISTS guards make a re-run a no-op, and the same guards
 * make the migration itself safely re-runnable.
 */
describe('employee directory schema + backfill (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const columns = (table: string) =>
    prisma.$queryRaw<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = ${table}
      ORDER BY ordinal_position`;

  const indexes = (table: string) =>
    prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = ${table}`;

  describe('employees table (employee-directory design D2)', () => {
    it('has the expected columns', async () => {
      const cols = await columns('employees');
      const byName = Object.fromEntries(
        cols.map((c) => [
          c.column_name,
          { data_type: c.data_type, is_nullable: c.is_nullable, column_default: c.column_default },
        ]),
      );
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining([
          'id',
          'organization_id',
          'employee_number',
          'name',
          'department',
          'active',
          'created_at',
          'updated_at',
        ]),
      );
      // `name` is nullable ONLY for rows adopted from history; `department` is
      // optional everywhere. `active` defaults to true (an adopted/seeded
      // employee is submittable without an explicit flag).
      expect(byName['name'].is_nullable).toBe('YES');
      expect(byName['department'].is_nullable).toBe('YES');
      expect(byName['employee_number'].is_nullable).toBe('NO');
      expect(byName['organization_id'].is_nullable).toBe('NO');
      expect(byName['active'].column_default?.replace(/::.*$/, '')).toBe('true');
    });

    it('keeps employee numbers tenant-local: unique per (organization, number), cascade FK', async () => {
      const idx = await indexes('employees');
      expect(
        idx.some((i) => i.indexdef.includes('employees_organization_id_employee_number_key')),
      ).toBe(true);

      const keys = await prisma.$queryRaw<Array<{ conname: string; confdeltype: 'a' | 'c' }>>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE contype = 'f' AND conname = 'employees_organization_id_fkey'`;
      expect(keys).toHaveLength(1);
      // Cascade: deleting the tenant wipes its directory, exactly like its
      // events and memberships (no orphaned roster rows).
      expect(keys[0].confdeltype).toBe('c');
    });

    it('rejects a duplicated number inside one organization but keeps two organizations independent', async () => {
      const suffix = Date.now();
      const orgA = await prisma.organization.create({
        data: { name: 'Dir A', slug: `dir-a-${suffix}` },
      });
      const orgB = await prisma.organization.create({
        data: { name: 'Dir B', slug: `dir-b-${suffix}` },
      });
      try {
        await prisma.employee.create({
          data: { organizationId: orgA.id, employeeNumber: 'emp-001', name: 'A one' },
        });
        // Same number in another organization: an independent employee.
        await prisma.employee.create({
          data: { organizationId: orgB.id, employeeNumber: 'emp-001', name: 'B one' },
        });
        // Same number in the SAME organization: the unique constraint is the
        // arbiter (the service maps P2002 → 409, but the store itself must
        // reject it — that is the duplicate-create guarantee).
        await expect(
          prisma.employee.create({
            data: { organizationId: orgA.id, employeeNumber: 'emp-001', name: 'A again' },
          }),
        ).rejects.toThrow();
      } finally {
        await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
      }
    });
  });

  describe('migration backfill (design D8: adoption + demo seeding, re-runnable)', () => {
    /**
     * Mirrors migration 20261016000000_employee_directory statements (b) and
     * (c) verbatim. The application-level idempotency guards are the contract:
     * running them again must change nothing already present.
     */
    const adoptObservedEmployeeIds = () =>
      prisma.$executeRaw`
        INSERT INTO "employees" ("id", "organization_id", "employee_number", "name", "department", "active", "created_at", "updated_at")
        SELECT gen_random_uuid()::text, p."organization_id", p."employee_id", NULL, NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM (SELECT DISTINCT "organization_id", "employee_id" FROM "payroll_events") AS p
        WHERE NOT EXISTS (
            SELECT 1 FROM "employees" e
            WHERE e."organization_id" = p."organization_id"
              AND e."employee_number" = p."employee_id"
        )`;

    const seedDemoEmployees = () =>
      prisma.$executeRaw`
        INSERT INTO "employees" ("id", "organization_id", "employee_number", "name", "department", "active", "created_at", "updated_at")
        SELECT gen_random_uuid()::text, o."id", s."number", s."name", 'Demo', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM "organizations" o
        CROSS JOIN (VALUES
            ('EMP-DEMO-SUCCESS',   'Demo employee (success)'),
            ('EMP-DEMO-RECOVER',   'Demo employee (recover)'),
            ('EMP-DEMO-TRANSIENT', 'Demo employee (transient)'),
            ('EMP-DEMO-FAILAFTER', 'Demo employee (fail-after-retries)'),
            ('EMP-DEMO-PERMANENT', 'Demo employee (permanent)')
        ) AS s("number", "name")
        WHERE NOT EXISTS (
            SELECT 1 FROM "employees" e
            WHERE e."organization_id" = o."id"
              AND e."employee_number" = s."number"
        )`;

    /** Serializable snapshot of the org's event rows — asserted identical across the backfill. */
    const eventSnapshot = (organizationId: string) =>
      prisma.payrollEvent
        .findMany({
          where: { organizationId },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            employeeId: true,
            eventType: true,
            sequence: true,
            status: true,
            payload: true,
            idempotencyKey: true,
          },
        })
        .then((rows) => rows.map((r) => ({ ...r, sequence: r.sequence.toString() })));

    const directoryRows = (organizationId: string) =>
      prisma.employee.findMany({
        where: { organizationId },
        orderBy: { employeeNumber: 'asc' },
      });

    const suffix = Date.now();
    const orgName = { name: 'Backfill Check', slug: `backfill-${suffix}` };
    // History predating the directory: two arbitrary (integrator-chosen) ids
    // AND one reserved demo id — this organization demoed the scenarios before
    // the directory existed.
    const history = [
      { employeeId: `legacy-integration-${suffix}`, sequence: 1n },
      { employeeId: `legacy-typo-${suffix}`, sequence: 2n },
      { employeeId: 'EMP-DEMO-TRANSIENT', sequence: 3n },
    ];

    let orgId = '';
    let snapshot: Awaited<ReturnType<typeof eventSnapshot>> = [];
    let legacyIdA = '';
    let legacyIdB = '';

    beforeAll(async () => {
      const org = await prisma.organization.create({ data: orgName });
      orgId = org.id;
      for (const [i, h] of history.entries()) {
        await prisma.payrollEvent.create({
          data: {
            organizationId: orgId,
            eventType: 'SALARY_CHANGE',
            employeeId: h.employeeId,
            payload: {
              employeeId: h.employeeId,
              effectiveDate: '2026-01-0' + (i + 1),
              newSalary: 1000 + i,
              currency: 'EUR',
            },
            sequence: h.sequence,
            idempotencyKey: `backfill-key-${suffix}-${i}`,
          },
        });
      }
      legacyIdA = history[0].employeeId;
      legacyIdB = history[1].employeeId;
      snapshot = await eventSnapshot(orgId);
    });

    afterAll(async () => {
      // Cascade wipes this org's events and directory rows; other orgs stay.
      if (orgId) {
        await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
      }
    });

    it('adopts observed event ids as active rows with an unknown name, and seeds the missing demo employees', async () => {
      // The org was created via the store AFTER the migration ran, so its
      // directory starts empty; running the statements here IS the migration's
      // documented re-run behavior for a fresh-at-deploy-time org too.
      expect(await directoryRows(orgId)).toHaveLength(0);

      await adoptObservedEmployeeIds();
      await seedDemoEmployees();

      const rows = await directoryRows(orgId);
      const byNumber = Object.fromEntries(rows.map((r) => [r.employeeNumber, r]));

      // Two legacy ids adopted, active, name unknown — the pre-directory world
      // keeps submitting after the gate lands.
      expect(rows).toHaveLength(7);
      expect(byNumber[legacyIdA]).toMatchObject({ active: true, name: null });
      expect(byNumber[legacyIdB]).toMatchObject({ active: true, name: null });
      // The adopted demo id came from history (name NULL); the seeding that
      // ran after must NOT have "fixed" its name — NOT EXISTS guard.
      expect(byNumber['EMP-DEMO-TRANSIENT']).toMatchObject({ active: true, name: null });

      // The four demo ids missing from history were seeded with directory
      // metadata from the house convention.
      for (const id of ['EMP-DEMO-SUCCESS', 'EMP-DEMO-RECOVER', 'EMP-DEMO-FAILAFTER', 'EMP-DEMO-PERMANENT']) {
        expect(byNumber[id]).toMatchObject({
          active: true,
          department: 'Demo',
          name: expect.stringContaining('Demo employee'),
        });
      }
      // The demo numbers present are exactly the shared constant's set — the
      // processing lever's contract lives in @repo/shared.
      const demoNumbers = DEMO_EMPLOYEE_SEEDS.map((s) => s.employeeNumber).sort();
      const presentDemo = rows
        .map((r) => r.employeeNumber)
        .filter((n) => n.startsWith('EMP-DEMO-'))
        .sort();
      expect(presentDemo).toEqual(demoNumbers);
    });

    it('keeps pre-existing history byte-identical through both statements', async () => {
      expect(await eventSnapshot(orgId)).toEqual(snapshot);
    });

    it('is a no-op when re-run (the migration is safely re-appliable)', async () => {
      const before = await directoryRows(orgId);
      await adoptObservedEmployeeIds();
      await seedDemoEmployees();
      const after = await directoryRows(orgId);

      expect(after.length).toBe(before.length);
      expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
      expect(await eventSnapshot(orgId)).toEqual(snapshot);
    });
  });
});
