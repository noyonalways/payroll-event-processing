import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * DB-level coverage for the idempotency_records migration: the
 * UNIQUE (organization_id, scope, key) arbiter and the expires_at index that
 * powers the sweep. Runs against the real Dockerized Postgres.
 *
 * The organization is part of the key by construction, so these tests assert the
 * three-way identity directly: the same key must collide within one organization
 * and must NOT collide across organizations or across scopes. The cross-tenant
 * case is the security-relevant one — a global key space would serve one
 * tenant's stored response body to another tenant that happened to reuse a key.
 */
describe('idempotency_records constraints (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orgA: string;
  let orgB: string;

  const createOrganization = async (label: string): Promise<string> => {
    const organization = await prisma.organization.create({
      data: { name: `Idempotency ${label}`, slug: `idem-${label}-${randomUUID()}` },
    });
    return organization.id;
  };

  const record = (organizationId: string, scope: string, key: string, marker: string) => ({
    organizationId,
    scope,
    key,
    responseStatus: 201,
    responseBody: { marker },
    expiresAt: new Date(Date.now() + 60_000),
  });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    orgA = await createOrganization('a');
    orgB = await createOrganization('b');
  });

  afterAll(async () => {
    // Cascades to the records via the organization FK.
    await prisma.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await app.close();
  });

  it('enforces UNIQUE (organization_id, scope, key): a second insert for the same triple fails with P2002', async () => {
    const key = `dup-key-${randomUUID()}`;

    await prisma.idempotencyRecord.create({ data: record(orgA, 'test-scope', key, 'first') });

    await expect(
      prisma.idempotencyRecord.create({ data: record(orgA, 'test-scope', key, 'second') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same key in different scopes within one organization', async () => {
    const key = `shared-key-${randomUUID()}`;

    await prisma.idempotencyRecord.create({ data: record(orgA, 'scope-a', key, 'a') });
    await prisma.idempotencyRecord.create({ data: record(orgA, 'scope-b', key, 'b') });

    expect(
      await prisma.idempotencyRecord.count({ where: { key, organizationId: orgA } }),
    ).toBe(2);
  });

  it('allows the same key in different organizations (no cross-tenant collision)', async () => {
    const key = `cross-tenant-${randomUUID()}`;

    await prisma.idempotencyRecord.create({ data: record(orgA, 'event-submission', key, 'tenant-a') });
    await prisma.idempotencyRecord.create({ data: record(orgB, 'event-submission', key, 'tenant-b') });

    // Both rows exist and are separately addressable: neither tenant can be
    // served the other's stored response for the same client-chosen key.
    const records = await prisma.idempotencyRecord.findMany({
      where: { key },
      orderBy: { organizationId: 'asc' },
    });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.organizationId).sort()).toEqual([orgA, orgB].sort());
    expect(records.map((r) => (r.responseBody as { marker: string }).marker).sort()).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
  });

  it('requires the organization (the discriminator is NOT NULL with no default)', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "idempotency_records" ("id", "scope", "key", "response_status", "response_body", "expires_at", "created_at")
        VALUES (${randomUUID()}, 'event-submission', ${`no-org-${randomUUID()}`}, 201, '{}'::jsonb, now() + interval '1 day', now())`,
    ).rejects.toThrow();
  });

  it('removes an organization’s records when the organization is removed', async () => {
    const temporaryOrg = await createOrganization('temp');
    const key = `cascade-${randomUUID()}`;
    await prisma.idempotencyRecord.create({
      data: record(temporaryOrg, 'event-submission', key, 'gone'),
    });

    await prisma.organization.delete({ where: { id: temporaryOrg } });

    expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  });

  it('creates the tenant-qualified unique key and the expires_at index that powers the sweep', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'idempotency_records';`;

    const names = indexes.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining(['idempotency_records_organization_id_scope_key_key']),
    );
    expect(names).toEqual(
      expect.arrayContaining(['idempotency_records_expires_at_idx']),
    );
    // The pre-tenant global key is gone: leaving it in place would keep
    // re-introducing the cross-tenant collision this migration removes.
    expect(names).not.toContain('idempotency_records_scope_key_key');
  });
});
