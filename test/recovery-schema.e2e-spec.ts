import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

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

  describe('event_attempts (append-only terminal-outcome audit trail)', () => {
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
});