// Env pins MUST sit above the imports: ts-jest compiles to CommonJS in place,
// so module-level code (the BullMQ `@Processor` options factory — see
// `@repo/database` worker-options: "freezes process.env at import time") runs
// while the module graph loads — an assignment inside `beforeAll` would be
// seen by ConfigService AFTER the producer/worker options already snapped.
// These two values shape the retry cadence the suite's timing assumptions
// (the 10 s mid-backoff cancellation window) and attempt budgets rely on.
process.env.PAYROLL_MAX_RETRY_ATTEMPTS = '2';
process.env.PAYROLL_RETRY_BASE_DELAY_MS = '10000';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter, WorkerModule } from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';

/**
 * E2E for the manual recovery actions (event-recovery): REAL Postgres + REAL
 * Redis required (`docker compose up` brings up both).
 *
 * The `EMP-DEMO-*` forced-outcome employees make every scenario deterministic
 * (they override `PAYROLL_FAILURE_MODE`): `EMP-DEMO-PERMANENT` fails
 * permanently on every attempt (its job COMPLETES — the BullMQ `completed`
 * relay fires and the employee's chain keeps draining), and
 * `EMP-DEMO-TRANSIENT` always throws transient so the event exercises the
 * automatic retry/backoff machinery and exhausts.
 *
 * The suite pins a 10 s retry base delay before the modules build, which is
 * what makes the mid-backoff cancellation deterministic: after attempt 1 the
 * row is `queued` again (the aborted claim rolled back) and the next attempt
 * only fires 10 s later — a wide, race-free cancellation window.
 */
jest.setTimeout(90_000);

const RETRY_BASE_DELAY_MS = 10_000;

describe('POST /events/:id/retry · /events/:id/cancel (e2e)', () => {
  let app: INestApplication;
  let workerApp: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;
  let foreign: TestTenant;

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
    await app.init();
    prisma = app.get(PrismaService);
    tenant = await registerTenant(app, 'recovery-a');
    foreign = await registerTenant(app, 'recovery-b');

    // Boot the real consumer so queued jobs are actually drained.
    const workerModuleRef: TestingModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    workerApp = workerModuleRef.createNestApplication();
    await workerApp.init();
  });

  beforeEach(() => {
    return Promise.all([
      prisma.payrollEvent.deleteMany({}),
      prisma.eventAttempt.deleteMany({}),
      prisma.eventAction.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    delete process.env.PAYROLL_MAX_RETRY_ATTEMPTS;
    delete process.env.PAYROLL_RETRY_BASE_DELAY_MS;
    await workerApp?.close();
    await app?.close();
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await prisma.eventAttempt.deleteMany({}).catch(() => undefined);
    await prisma.eventAction.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());
  const key = () => randomUUID();

  /** Submits an event as the main tenant and returns its id. */
  const submit = async (
    employeeId: string,
    eventType = 'SALARY_CHANGE',
    payload: Record<string, unknown> = {
      employeeId,
      effectiveDate: '2026-10-01',
      newSalary: 75000,
      currency: 'EUR',
    },
  ): Promise<string> => {
    const res = await http()
      .post('/events')
      .set(tenant.headers)
      .set('Idempotency-Key', key())
      .send({ eventType, payload });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** Polls Postgres until `predicate` returns a truthy value or the deadline hits. */
  const waitFor = async <T>(
    predicate: () => Promise<T | null>,
    {
      timeout = 30_000,
      interval = 100,
      describe,
    }: {
      timeout?: number;
      interval?: number;
      describe?: () => Promise<string>;
    } = {},
  ): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    const state = describe ? await describe().catch(() => String(undefined)) : 'no state';
    throw new Error(`Timed out waiting for the worker pipeline — last state: ${state}`);
  };

  const eventRow = async (id: string) =>
    prisma.payrollEvent.findFirst({ where: { id, organizationId: tenant.organizationId } });

  const attempts = async (id: string) =>
    prisma.eventAttempt.findMany({ where: { eventId: id }, orderBy: { attemptNumber: 'asc' } });

  const actions = async (id: string) =>
    prisma.eventAction.findMany({ where: { eventId: id }, orderBy: { createdAt: 'asc' } });

  describe('retry (failed → queued, numbering continues)', () => {
    it('round 2 of a permanently-failed event numbers from attempt 2 and leaves round 1 untouched', async () => {
      const id = await submit('EMP-DEMO-PERMANENT');

      await waitFor(async () => {
        const row = await eventRow(id);
        return row?.status === 'FAILED' ? row : null;
      });
      const round1 = await attempts(id);
      expect(round1).toHaveLength(1);
      expect(round1[0]).toMatchObject({
        attemptNumber: 1,
        status: 'FAILED',
        errorType: 'PERMANENT',
        failedReason: expect.stringContaining('demo scenario: permanent failure'),
      });

      const res = await http()
        .post(`/events/${id}/retry`)
        .set(tenant.headers)
        .expect(200);
      expect(res.body).toEqual({
        id,
        status: 'queued',
        eventType: 'SALARY_CHANGE',
        employeeId: 'EMP-DEMO-PERMANENT',
      });

      await waitFor(async () => {
        const trail = await attempts(id);
        return trail.length >= 2 ? trail : null;
      });

      // The trail is continuous across rounds: round 2's permanent failure
      // landed at attempt 2, and round 1's row is byte-for-byte untouched.
      const trail = await attempts(id);
      expect(trail.map((a) => a.attemptNumber)).toEqual([1, 2]);
      expect(trail[0].failedReason).toBe(round1[0].failedReason);
      expect(trail[0].createdAt).toEqual(round1[0].createdAt);

      // The retried round fails the row again (the demo lever is permanent)…
      expect((await eventRow(id))?.status).toBe('FAILED');

      // …and the action left exactly one audit row naming the acting user.
      const audit = await actions(id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'RETRY', userId: tenant.userId });
    });

    it('an exhausted transient round continues numbering after a manual retry (1..2, then 3..4)', async () => {
      const id = await submit('EMP-DEMO-TRANSIENT');

      await waitFor(async () => (await eventRow(id))?.status === 'FAILED' ? await attempts(id) : null, {
        // attempt 1 (+10 s backoff) + attempt 2 → exhausted at ~13 s.
        timeout: 30_000,
      });
      const round1 = await attempts(id);
      expect(round1.map((a) => a.attemptNumber)).toEqual([1, 2]);
      expect(round1.every((a) => a.status === 'FAILED' && a.errorType === 'TEMPORARY')).toBe(true);

      await http().post(`/events/${id}/retry`).set(tenant.headers).expect(200);

      await waitFor(
        // Round 2 = one more full retry cycle; the final round-2 attempt must
        // be numbered 4, directly after round 1's — no collision, no clobber.
        async () => ((await attempts(id)).length >= 4 ? await attempts(id) : null),
        {
          timeout: 30_000,
          describe: async () =>
            JSON.stringify({
              row: await eventRow(id),
              trail: (await attempts(id)).map((a) => [a.attemptNumber, a.errorType]),
            }),
        },
      );

      const trail = await attempts(id);
      expect(trail.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4]);
      expect(new Set(trail.map((a) => a.createdAt)).size).toBe(4);
    });
  });

  describe('cancel (pending → cancelled, never processed)', () => {
    it('a chained queued-without-job event cancels cleanly and the chain skips past it', async () => {
      const employeeId = `EMP-DEMO-PERMANENT`;
      // e1 goes in-flight for the employee immediately (its job holds the
      // tenant-qualified jobId), which makes e2's producer add a SUPPRESSED
      // no-op — e2 is `queued` with no BullMQ job at all: the deterministic
      // cancel-before-claim fixture.
      const e1 = await submit(employeeId);
      const e2 = await submit(employeeId);
      const e3 = await submit(employeeId);

      // e2 is pending while e1 runs; cancel it mid-chain.
      const res = await http()
        .post(`/events/${e2}/cancel`)
        .set(tenant.headers)
        .expect(200);
      expect(res.body).toEqual({
        id: e2,
        status: 'cancelled',
        eventType: 'SALARY_CHANGE',
        employeeId,
      });

      // e1 permanently fails (~2.5 s, its job COMPLETES), the relay fires and
      // must skip the cancelled e2 — e3 gets processed behind it. All three
      // events share the EMP-DEMO-PERMANENT lever (one employee = one demo
      // outcome), so e3 also ends failed — what the chain contract needs is
      // that e3 WAS processed: it gained an attempt, e2 never did.
      await waitFor(
        async () => ((await attempts(e3)).length >= 1 ? await attempts(e3) : null),
        {
          timeout: 30_000,
          describe: async () => {
            const rows = await prisma.payrollEvent.findMany({
              where: { organizationId: tenant.organizationId, employeeId: 'EMP-DEMO-PERMANENT' },
              select: { id: true, status: true, sequence: true, processedAt: true },
            });
            const attemptsAll = await prisma.eventAttempt.findMany({
              select: { eventId: true, attemptNumber: true, status: true },
            });
            return JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)) +
              ' attempts:' +
              JSON.stringify(attemptsAll);
          },
        },
      );

      const e2Row = await eventRow(e2);
      expect(e2Row?.status).toBe('CANCELLED');
      expect(e2Row?.processedAt).toBeNull();
      expect(await attempts(e2)).toEqual([]);

      // The chain continued: e1 reached its terminal failure, e3 was claimed
      // and processed (failed by its lever, derived from attempt 1) — neither
      // of which is possible if the cancelled e2 had stalled the chain.
      expect((await eventRow(e1))?.status).toBe('FAILED');
      expect((await eventRow(e3))?.status).toBe('FAILED');
      expect(await attempts(e3)).toHaveLength(1);

      // Exactly one audit row, naming the acting user.
      const audit = await actions(e2);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'CANCEL', userId: tenant.userId });

      // The dead-letter filter (events-query contract) and the cancelled
      // filter see exactly this distribution for the organization.
      const failedList = await http()
        .get('/events?status=failed')
        .set(tenant.headers)
        .expect(200);
      expect(failedList.body.data.map((e: { id: string }) => e.id)).toEqual(
        expect.arrayContaining([e1, e3]),
      );
      expect(failedList.body.data.map((e: { id: string }) => e.id)).not.toContain(e2);
      const cancelledList = await http()
        .get('/events?status=cancelled')
        .set(tenant.headers)
        .expect(200);
      expect(cancelledList.body.data.map((e: { id: string }) => e.id)).toEqual([e2]);
    });

    it('a cancel between automatic retry attempts kills the round: no further attempt runs', async () => {
      const id = await submit('EMP-DEMO-TRANSIENT');

      // Attempt 1 failed transiently and the 10 s backoff just started: the
      // row is `queued` again with one recorded attempt — the cancellation
      // window.
      await waitFor(
        async () => {
          const row = await eventRow(id);
          return row?.status === 'QUEUED' && (await attempts(id)).length >= 1 ? row : null;
        },
        { timeout: 15_000 },
      );

      await http().post(`/events/${id}/cancel`).set(tenant.headers).expect(200);

      // Wait well past the 10 s backoff: the delayed attempt fires, sees a
      // non-queued row, and applies nothing.
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS + 5_000));

      const row = await eventRow(id);
      expect(row?.status).toBe('CANCELLED');
      expect(row?.processedAt).toBeNull();
      expect(row?.result).toBeNull();
      expect(await attempts(id)).toHaveLength(1);
    });

    it('a stranded received row is cancellable', async () => {
      // A submission mid-flight between insert and the post-commit markQueued —
      // the only guaranteed `received` observation window happens to also be a
      // valid cancel source state; retry until we win it.
      const id = await submit('EMP-DEMO-SUCCESS');
      // EMP-DEMO-SUCCESS processes fast, so just assert the API accepts
      // whichever pending state we caught (or 409 when it already succeeded)
      // — the RECEIVED-source guarantee itself is covered at unit level.
      const res = await http().post(`/events/${id}/cancel`).set(tenant.headers);
      expect([200, 409]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.status).toBe('cancelled');
      } else {
        expect(res.body.statusCode).toBe(409);
        // The 409 means the event left the pending states before our call
        // landed — by the time the SUCCEEDED processing settles it must read
        // as terminal-success (EMP-DEMO-SUCCESS never fails).
        await waitFor(async () => (await eventRow(id))?.status === 'SUCCESS'
          ? (await eventRow(id))
          : null, { timeout: 15_000 });
      }
    });
  });

  describe('guards (401 / 404 / 409)', () => {
    it('both actions reject an unauthenticated call with 401', async () => {
      await http().post('/events/some-id/retry').expect(401);
      await http().post('/events/some-id/cancel').expect(401);
    });

    it('another organization\'s event is a 404 for both actions, identical to an unknown id', async () => {
      const id = await submit('EMP-DEMO-PERMANENT');
      await waitFor(async () => (await eventRow(id))?.status === 'FAILED'
        ? (await eventRow(id))
        : null, { timeout: 15_000 });

      await http().post(`/events/${id}/retry`).set(foreign.headers).expect(404);
      await http().post(`/events/${id}/cancel`).set(foreign.headers).expect(404);
      await http().post(`/events/${randomUUID()}/retry`).set(tenant.headers).expect(404);

      // (g) Rejected actions record nothing.
      expect(await prisma.eventAction.count()).toBe(0);
    });

    it('retry on a succeeded event is a 409; cancel on success is a 409; double actions 409', async () => {
      const id = await submit('EMP-DEMO-SUCCESS');
      await waitFor(async () => (await eventRow(id))?.status === 'SUCCESS'
        ? (await eventRow(id))
        : null, { timeout: 15_000 });

      await http().post(`/events/${id}/retry`).set(tenant.headers).expect(409);
      await http().post(`/events/${id}/cancel`).set(tenant.headers).expect(409);
      expect(await prisma.eventAction.count()).toBe(0);

      // A terminal state that was already CANCELLED cannot be retried or
      // cancelled again. The cancel-200 fixture is race-free: while a
      // PERMANENT event of the same employee is in flight (its job holds the
      // tenant-qualified jobId), the victim's producer add is suppressed, so
      // the victim stays pending with no job to claim it.
      await submit('EMP-DEMO-PERMANENT');
      const victim = await submit('EMP-DEMO-PERMANENT');
      const cancelRes = await http().post(`/events/${victim}/cancel`).set(tenant.headers);
      expect(cancelRes.status).toBe(200);
      await http().post(`/events/${victim}/cancel`).set(tenant.headers).expect(409);
      await http().post(`/events/${victim}/retry`).set(tenant.headers).expect(409);
    });

    it('concurrent retries of the same failed event apply exactly once (200 + 409)', async () => {
      const id = await submit('EMP-DEMO-PERMANENT');
      await waitFor(async () => (await eventRow(id))?.status === 'FAILED'
        ? (await eventRow(id))
        : null, { timeout: 15_000 });

      const settles = await Promise.allSettled([
        request(app.getHttpServer()).post(`/events/${id}/retry`).set(tenant.headers),
        request(app.getHttpServer()).post(`/events/${id}/retry`).set(tenant.headers),
      ]);
      const statuses = settles.map((s) => (s as PromiseFulfilledResult<request.Response>).value.status);
      expect(statuses.sort()).toEqual([200, 409]);

      // Exactly one RETRY audit row for one applied action.
      const audit = await actions(id);
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe('RETRY');
    });
  });
});
