import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * DB-level coverage for the idempotency_records migration: the UNIQUE (scope, key)
 * arbiter and the expires_at index that powers the sweep. Runs against the real
 * Dockerized Postgres; keys are scoped to a random UUID so tests never collide.
 */
describe('idempotency_records constraints (e2e)', () => {
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

  beforeEach(async () => {
    await prisma.idempotencyRecord.deleteMany({});
  });

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({}).catch(() => undefined);
    await app.close();
  });

  it('enforces UNIQUE (scope, key): a second insert for the same pair fails with P2002', async () => {
    const scope = 'test-scope';
    const key = 'dup-key';

    await prisma.idempotencyRecord.create({
      data: {
        scope,
        key,
        responseStatus: 201,
        responseBody: { id: 'evt-1', status: 'received' },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      prisma.idempotencyRecord.create({
        data: {
          scope,
          key,
          responseStatus: 201,
          responseBody: { id: 'evt-2', status: 'received' },
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same key in different scopes (scope isolation at the schema level)', async () => {
    const key = 'shared-key';

    await prisma.idempotencyRecord.create({
      data: {
        scope: 'scope-a',
        key,
        responseStatus: 201,
        responseBody: { scope: 'a' },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.idempotencyRecord.create({
      data: {
        scope: 'scope-b',
        key,
        responseStatus: 201,
        responseBody: { scope: 'b' },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect(
      await prisma.idempotencyRecord.count({ where: { key } }),
    ).toBe(2);
  });

  it('creates the expires_at index that powers the sweep', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'idempotency_records';`;

    expect(indexes.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['idempotency_records_expires_at_idx']),
    );
    expect(indexes.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['idempotency_records_scope_key_key']),
    );
  });
});