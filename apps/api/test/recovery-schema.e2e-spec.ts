import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '@repo/core';
import { PrismaService } from '@repo/database';

/**
 * Integration coverage for the `concurrency-and-crash-recovery` migration:
 * asserts the two new tables exist with the expected columns and indexes in a
 * REAL Postgres (docker compose), via information_schema / pg_indexes. Verified
 * additive — existing tables are not touched here (their shape is covered by
 * the older, still-passing suites).
 */
describe('recovery schema (event_attempts / worker_heartbeats) (e2e)', () => {
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
    prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = ${table}
      ORDER BY ordinal_position`;

  const indexes = (table: string) =>
    prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = ${table}`;

  describe('event_attempts (append-only per-attempt audit trail)', () => {
    it('has the expected columns', async () => {
      const cols = await columns('event_attempts');
      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining([
          'id',
          'event_id',
          'attempt_number',
          'status',
          'error_type',
          'failed_reason',
          'result',
          'created_at',
        ]),
      );
      expect(byName['result']).toBe('jsonb');
      expect(byName['attempt_number']).toBe('integer');
    });

    it('indexes event_id for the per-event audit lookup', async () => {
      const idx = await indexes('event_attempts');
      expect(idx.some((i) => i.indexdef.includes('event_attempts_event_id_idx'))).toBe(
        true,
      );
    });

    it('enforces one row per attempt number per event (UNIQUE event_id + attempt_number)', async () => {
      const idx = await indexes('event_attempts');
      expect(
        idx.some((i) =>
          i.indexdef.includes('event_attempts_event_id_attempt_number_key'),
        ),
      ).toBe(true);
    });
  });

  describe('worker_heartbeats (worker liveness)', () => {
    it('has the expected columns', async () => {
      const cols = await columns('worker_heartbeats');
      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining(['worker_id', 'hostname', 'started_at', 'last_seen_at']),
      );
    });

    it('is keyed by worker_id (single row per worker)', async () => {
      const idx = await indexes('worker_heartbeats');
      expect(idx.some((i) => i.indexdef.includes('worker_heartbeats_pkey'))).toBe(true);
    });
  });

  describe('multi-tenant foundation (organizations, tenant discriminator, tenant-qualified keys)', () => {
    const nullability = (table: string, column: string) =>
      prisma.$queryRaw<Array<{ is_nullable: string; column_default: string | null }>>`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = ${table} AND column_name = ${column}`;

    it('creates the tenant and identity tables', async () => {
      for (const table of ['organizations', 'users', 'memberships', 'refresh_tokens']) {
        const cols = await columns(table);
        expect(cols.length).toBeGreaterThan(0);
      }
    });

    it('records the organization on every tenant-owned table, NOT NULL and with no default', async () => {
      for (const table of ['payroll_events', 'idempotency_records']) {
        const [column] = await nullability(table, 'organization_id');
        expect(column).toBeDefined();
        // Enforced in the DATABASE, not merely in Prisma: a future writer that
        // forgets the tenant must be rejected rather than silently misfiled.
        expect(column.is_nullable).toBe('NO');
        expect(column.column_default).toBeNull();
      }
    });

    it('replaces the global unique keys with tenant-qualified ones', async () => {
      const eventIndexes = (await indexes('payroll_events')).map((i) => i.indexdef).join('\n');

      expect(eventIndexes).toContain('payroll_events_organization_id_employee_id_sequence_key');
      // The pre-tenant key would let two organizations collide on an employee
      // number and share one sequence space.
      expect(eventIndexes).not.toContain('"employee_id", "sequence")');

      // Tenant-leading composite indexes, so the tenant-filtered access path is
      // the indexed one.
      expect(eventIndexes).toContain('payroll_events_organization_id_status_idx');
      expect(eventIndexes).toContain(
        'payroll_events_organization_id_employee_id_created_at_idx',
      );
    });

    it('enforces organization foreign keys on the tenant-owned tables', async () => {
      const keys = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'f'
          AND conname IN (
            'payroll_events_organization_id_fkey',
            'idempotency_records_organization_id_fkey',
            'memberships_user_id_fkey',
            'memberships_organization_id_fkey',
            'refresh_tokens_user_id_fkey',
            'refresh_tokens_organization_id_fkey'
          )`;

      expect(keys.map((k) => k.conname).sort()).toEqual(
        [
          'idempotency_records_organization_id_fkey',
          'memberships_organization_id_fkey',
          'memberships_user_id_fkey',
          'payroll_events_organization_id_fkey',
          'refresh_tokens_organization_id_fkey',
          'refresh_tokens_user_id_fkey',
        ].sort(),
      );
    });

    it('enforces a real foreign key from event_attempts to payroll_events', async () => {
      const keys = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND conname = 'event_attempts_event_id_fkey'`;
      expect(keys).toHaveLength(1);

      // The FK must actually reject an orphan: event_id was previously an
      // unenforced column, so a trail row could outlive its event.
      await expect(
        prisma.$executeRaw`
          INSERT INTO "event_attempts" ("id", "event_id", "attempt_number", "status", "created_at")
          VALUES (gen_random_uuid()::text, ${'no-such-event-' + Date.now()}, 1, 'SUCCESS', now())`,
      ).rejects.toThrow();
    });

    it('ignores an attempt row whose event was removed (cascade)', async () => {
      const organization = await prisma.organization.create({
        data: { name: 'Cascade Check', slug: `cascade-${Date.now()}` },
      });
      const event = await prisma.payrollEvent.create({
        data: {
          organizationId: organization.id,
          eventType: 'SALARY_CHANGE',
          employeeId: 'cascade-emp',
          payload: { employeeId: 'cascade-emp' },
          sequence: 1n,
          idempotencyKey: `cascade-key-${Date.now()}`,
        },
      });
      await prisma.eventAttempt.create({
        data: { eventId: event.id, attemptNumber: 1, status: 'SUCCESS' },
      });

      await prisma.organization.delete({ where: { id: organization.id } });

      expect(await prisma.eventAttempt.count({ where: { eventId: event.id } })).toBe(0);
      expect(await prisma.payrollEvent.count({ where: { id: event.id } })).toBe(0);
    });
  });

  describe('event recovery (CANCELLED status, attempt_base, event_actions)', () => {
    it('has CANCELLED in the EventStatus enum, after the pre-existing values', async () => {
      const labels = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'EventStatus'
        ORDER BY e.enumsortorder`;
      expect(labels.map((l) => l.enumlabel)).toEqual([
        'RECEIVED',
        'QUEUED',
        'PROCESSING',
        'SUCCESS',
        'FAILED',
        'CANCELLED',
      ]);
    });

    it('adds attempt_base (integer, default 0) to payroll_events', async () => {
      const [column] = await prisma.$queryRaw<
        Array<{ data_type: string; column_default: string | null; is_nullable: string }>
      >`
        SELECT data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'payroll_events' AND column_name = 'attempt_base'`;
      // Additive: existing rows (and every non-retry path) keep 0, which is
      // exactly today's numbering.
      expect(column).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
      expect(column.column_default?.replace(/::.*$/, '')).toBe('0');
    });

    it('creates event_actions with the expected columns and the per-event index', async () => {
      const cols = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; udt_name: string }>
      >`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'event_actions'
        ORDER BY ordinal_position`;
      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining(['id', 'event_id', 'action', 'user_id', 'created_at']),
      );
      // `action` is the new EventActionType enum; `user_id` is a plain text
      // snapshot, deliberately not a relation.
      expect(byName['action']).toMatchObject({ data_type: 'USER-DEFINED', udt_name: 'EventActionType' });
      expect(byName['user_id']).toMatchObject({ data_type: 'text' });
      const idx = await indexes('event_actions');
      expect(idx.some((i) => i.indexdef.includes('event_actions_event_id_idx'))).toBe(true);
    });

    it('enforces a cascading foreign key from event_actions to payroll_events', async () => {
      const keys = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND conname = 'event_actions_event_id_fkey'`;
      expect(keys).toHaveLength(1);
      // Same orphan-rejection guarantee the attempts trail carries: an audit
      // row cannot outlive its event.
      await expect(
        prisma.$executeRaw`
          INSERT INTO "event_actions" ("id", "event_id", "action", "user_id", "created_at")
          VALUES (gen_random_uuid()::text, ${'no-such-event-' + Date.now()}, 'RETRY', 'user', now())`,
      ).rejects.toThrow();
    });

    it('reads a cancelled row back as CANCELLED and keeps audit rows only where written', async () => {
      const organization = await prisma.organization.create({
        data: { name: 'Recovery Schema Check', slug: `recovery-${Date.now()}` },
      });
      const event = await prisma.payrollEvent.create({
        data: {
          organizationId: organization.id,
          eventType: 'SALARY_CHANGE',
          employeeId: 'recovery-emp',
          payload: { employeeId: 'recovery-emp' },
          sequence: 1n,
          idempotencyKey: `recovery-key-${Date.now()}`,
        },
      });

      await prisma.payrollEvent.update({
        where: { id: event.id },
        data: { status: 'CANCELLED' },
      });
      // Exactly one audit row for the one action that happened — and nothing
      // creates rows by itself.
      await prisma.eventAction.create({
        data: { eventId: event.id, action: 'CANCEL', userId: 'schema-check-user' },
      });

      const reread = await prisma.payrollEvent.findUnique({ where: { id: event.id } });
      expect(reread?.status).toBe('CANCELLED');
      expect(reread?.attemptBase).toBe(0);
      expect(await prisma.eventAction.count({ where: { eventId: event.id } })).toBe(1);

      await prisma.organization.delete({ where: { id: organization.id } });
      expect(await prisma.eventAction.count({ where: { eventId: event.id } })).toBe(0);
    });
  });
});