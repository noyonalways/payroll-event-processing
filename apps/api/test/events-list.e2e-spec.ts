import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';
import { ensureEmployee } from './support/directory';

/**
 * E2E for the read-only event-history surface of GET /events
 * (events-query-api) — REAL Postgres + REAL Redis required (`docker compose up`).
 *
 * The suite registers real organizations through the HTTP surface (the shared
 * auth helper) and submits real events through POST /events, so pagination,
 * filters, and scoping are exercised against the same rows a client would page
 * through. No worker is booted here: submitted rows stay `queued`, which is
 * exactly what makes the listing assertions deterministic (statuses never move
 * under the test's feet).
 *
 * Ordering is verified against the CONTRACT — `created_at DESC, id DESC` —
 * not against insertion time alone: the repository guarantees the id
 * tiebreaker, and burst submissions may legally share one timestamp.
 */
jest.setTimeout(30_000);

interface ListEntry {
  id: string;
  eventType: string;
  employeeId: string;
  sequence: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

interface ListBody {
  data: ListEntry[];
  limit: number;
  nextCursor: string | null;
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

/** Newest-first per the contract: (created_at, id) descending. */
const newestFirstIndex = (a: [string, string], b: [string, string]): number =>
  b[0].localeCompare(a[0]) || (b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : 0);

describe('GET /events (events-query-api)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  let otherTenant: TestTenant;

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
    tenant = await registerTenant(app, 'events-list');
    otherTenant = await registerTenant(app, 'events-list-other');

    // Every literal employeeId this suite submits must be an ACTIVE directory
    // employee of the submitting organization (submission gate).
    for (const number of ['emp-0', 'emp-1', 'emp-2', 'emp-3', 'emp-4', 'emp-5', 'emp-6', 'emp-last', 'emp-new', 'emp-x', 'emp-y']) {
      await ensureEmployee(prisma, tenant.organizationId, number);
    }
    await ensureEmployee(prisma, otherTenant.organizationId, 'emp-1');
  });

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({});
    await prisma.eventAttempt.deleteMany({});
  });

  afterAll(async () => {
    await app?.close();
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await prisma.eventAttempt.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());

  /** Submits one event through the real POST /events surface. */
  const submit = async (
    as: TestTenant,
    eventType: string,
    employeeId: string,
  ): Promise<{ id: string }> => {
    const payload =
      eventType === 'SALARY_CHANGE' ? SALARY_PAYLOAD(employeeId) : BANK_PAYLOAD(employeeId);
    const res = await http()
      .post('/events')
      .set(as.headers)
      .set('Idempotency-Key', randomUUID())
      .send({ eventType, payload })
      .expect(201);
    return { id: res.body.id as string };
  };

  /** GET /events as `as`, with the given query object (no expectation attached). */
  const listPage = (as: TestTenant, query: Record<string, string | number>) =>
    http().get('/events').set(as.headers).query(query);

  const listOk = async (
    as: TestTenant,
    query: Record<string, string | number> = {},
  ): Promise<ListBody> =>
    (await listPage(as, query).expect(200)).body as ListBody;

  describe('authentication and first page (3.1)', () => {
    it('rejects an unauthenticated call without returning any events', async () => {
      await submit(tenant, 'BANK_ACCOUNT_CHANGE', 'emp-1');

      const res = await http().get('/events').expect(401);

      expect(res.body).toMatchObject({
        statusCode: 401,
        error: 'UnauthorizedException',
      });
      expect(res.body.data).toBeUndefined();
    });

    it('returns the documented first-page shape, newest first, with the light row', async () => {
      // Enough events for a default-size page and a nextCursor.
      for (let i = 0; i < 5; i += 1) {
        await submit(tenant, i % 2 === 0 ? 'BANK_ACCOUNT_CHANGE' : 'SALARY_CHANGE', `emp-${i}`);
        // Keep wall-clock creation times apart so the newest submission is
        // unambiguous even with ms-granularity timestamps.
        await new Promise((r) => setTimeout(r, 10));
      }
      const lastId = (await submit(tenant, 'SALARY_CHANGE', 'emp-last')).id;
      const total = await prisma.payrollEvent.count({
        where: { organizationId: tenant.organizationId },
      });
      expect(total).toBe(6);

      const body = await listOk(tenant);

      expect(body.limit).toBe(20); // the documented default page size
      expect(body.nextCursor).toBeNull(); // everything fits on one page
      expect(body.data).toHaveLength(6);

      // The documented light row: identity + shape + timing, nothing else.
      const expectedKeys = [
        'createdAt',
        'employeeId',
        'eventType',
        'id',
        'processedAt',
        'sequence',
        'status',
        'updatedAt',
      ].sort();
      for (const entry of body.data) {
        expect(Object.keys(entry).sort()).toEqual(expectedKeys);
        expect(entry.status).toBe('queued');
        expect(typeof entry.sequence).toBe('number');
      }

      // Newest first per the contract tuple, and the most recent submission
      // (strictly later wall-clock creation) leads the page.
      const actual: Array<[string, string]> = body.data.map((e) => [e.createdAt, e.id]);
      expect(actual).toEqual([...actual].sort(newestFirstIndex));
      expect(body.data[0].id).toBe(lastId);
      expect(body.data[0].employeeId).toBe('emp-last');
    });
  });

  describe('cursor walk and tenant scoping (3.1)', () => {
    it('walking every page yields each of the organization’s events exactly once', async () => {
      const submitted: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        submitted.push(
          (await submit(tenant, i % 2 === 0 ? 'BANK_ACCOUNT_CHANGE' : 'SALARY_CHANGE', `emp-${i % 4}`)).id,
        );
        await new Promise((r) => setTimeout(r, 10));
      }

      // Walk with a page size that forces several pages, including a partial last one.
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const body = await listOk(tenant, {
          limit: 5,
          ...(cursor ? { cursor } : {}),
        });
        expect(body.limit).toBe(5);
        seen.push(...body.data.map((e) => e.id));
        cursor = body.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(10); // the walk must terminate
      } while (cursor);

      expect(pages).toBe(3); // 12 events ÷ 5 = 5 + 5 + 2
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12); // no repeats
      expect(new Set(seen)).toEqual(new Set(submitted)); // no skips
    });

    it('never returns another organization’s events, even with an identical employeeId', async () => {
      // Both organizations use the SAME employee number on purpose.
      const mine: string[] = [];
      const theirs: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        mine.push((await submit(tenant, 'SALARY_CHANGE', 'emp-1')).id);
        theirs.push((await submit(otherTenant, 'SALARY_CHANGE', 'emp-1')).id);
        await new Promise((r) => setTimeout(r, 10));
      }

      // Unfiltered pages of tenant A contain only tenant A's rows…
      const body = await listOk(tenant, { limit: 20 });
      expect(body.data.map((e) => e.id).sort()).toEqual([...mine].sort());

      // …the employeeId filter narrows within the caller's organization only…
      const filtered = await listOk(tenant, { employeeId: 'emp-1', limit: 20 });
      expect(filtered.data.map((e) => e.id).sort()).toEqual([...mine].sort());

      // …and paging never leaks the other tenant, whatever the parameters.
      let cursor: string | null = null;
      do {
        const page = await listOk(tenant, {
          limit: 2,
          employeeId: 'emp-1',
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of page.data) {
          expect(theirs).not.toContain(entry.id);
          expect(entry.employeeId).toBe('emp-1');
        }
        cursor = page.nextCursor;
      } while (cursor);

      // The other tenant sees the mirror image — its own rows only.
      const otherBody = await listOk(otherTenant, { limit: 20 });
      expect(otherBody.data.map((e) => e.id).sort()).toEqual([...theirs].sort());
    });
  });

  describe('filtering (3.2)', () => {
    it('carries combinable filters across every page of the walk', async () => {
      // 7 events match the filter; 6 events in the same organization must not.
      const matching: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        matching.push((await submit(tenant, 'SALARY_CHANGE', 'emp-x')).id);
        await new Promise((r) => setTimeout(r, 10));
      }
      for (let i = 0; i < 3; i += 1) {
        await submit(tenant, 'BANK_ACCOUNT_CHANGE', 'emp-x'); // wrong type
      }
      for (let i = 0; i < 3; i += 1) {
        await submit(tenant, 'SALARY_CHANGE', 'emp-y'); // wrong employee
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body = await listOk(tenant, {
          status: 'queued', // fresh submissions sit at queued
          eventType: 'SALARY_CHANGE',
          employeeId: 'emp-x',
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...body.data.map((e) => e.id));
        for (const entry of body.data) {
          expect(entry.eventType).toBe('SALARY_CHANGE');
          expect(entry.employeeId).toBe('emp-x');
          expect(entry.status).toBe('queued');
        }
        cursor = body.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(7);
      expect(new Set(seen)).toEqual(new Set(matching));
    });
  });

  describe('invalid parameters (3.2)', () => {
    beforeAll(async () => {
      await submit(tenant, 'BANK_ACCOUNT_CHANGE', 'emp-1');
    });

    const expectParam400 = async (query: Record<string, string | number>, param: string) => {
      const res = await listPage(tenant, query).expect(400);
      expect(res.body.statusCode).toBe(400);
      const message = Array.isArray(res.body.message)
        ? res.body.message.join(' ')
        : res.body.message;
      expect(message).toContain(param);
      expect(res.body.data).toBeUndefined();
    };

    it('rejects an unknown status', async () => {
      await expectParam400({ status: 'archived' }, 'status');
    });

    it('rejects an unknown event type', async () => {
      await expectParam400({ eventType: 'PROMOTION' }, 'eventType');
    });

    it('rejects a malformed date bound', async () => {
      await expectParam400({ createdAfter: 'not-a-date' }, 'createdAfter');
      await expectParam400({ createdBefore: '2026-13-45' }, 'createdBefore');
    });

    it('rejects out-of-range page sizes', async () => {
      await expectParam400({ limit: 0 }, 'limit');
      await expectParam400({ limit: 101 }, 'limit');
    });

    it('rejects a malformed cursor with 400 instead of treating it as absent', async () => {
      const res = await listPage(tenant, { cursor: '@@not-issued-by-the-endpoint@@' }).expect(400);
      expect(res.body.statusCode).toBe(400);
      const message = Array.isArray(res.body.message)
        ? res.body.message.join(' ')
        : res.body.message;
      expect(message).toContain('cursor');
    });
  });

  describe('pagination stability under concurrent writes (3.3)', () => {
    it('keeps page 2 fixed when an event arrives between page fetches', async () => {
      for (let i = 0; i < 7; i += 1) {
        await submit(tenant, 'BANK_ACCOUNT_CHANGE', `emp-${i}`);
        await new Promise((r) => setTimeout(r, 10));
      }

      // Page 1 …
      const page1 = await listOk(tenant, { limit: 3 });
      expect(page1.nextCursor).not.toBeNull();
      // … and page 2 BEFORE anything else is written — the baseline.
      const page2Before = await listOk(tenant, { limit: 3, cursor: page1.nextCursor! });
      expect(page2Before.data).toHaveLength(3);

      // A new event is submitted while the client sits between pages. It is
      // now the newest row; offset pagination would shift everything.
      const submittedNow = await submit(tenant, 'SALARY_CHANGE', 'emp-new');

      // The stored cursor continues EXACTLY where page 1 left off.
      const page2After = await listOk(tenant, { limit: 3, cursor: page1.nextCursor! });

      expect(page2After.data.map((e) => e.id)).toEqual(page2Before.data.map((e) => e.id));
      expect(page2After.nextCursor).toEqual(page2Before.nextCursor);
      // No row from page 1 reappears; the new event is not on page 2.
      const page1Ids = new Set(page1.data.map((e) => e.id));
      for (const entry of page2After.data) {
        expect(page1Ids.has(entry.id)).toBe(false);
        expect(entry.id).not.toBe(submittedNow.id);
      }
      // A fresh page-1 view puts the new event at the head instead.
      const fresh = await listOk(tenant, { limit: 3 });
      expect(fresh.data[0].id).toBe(submittedNow.id);
    });
  });
});
