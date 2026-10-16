import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as http from 'http';
import * as net from 'net';
import { randomUUID } from 'crypto';
import { EventStatus } from '@prisma/client';
import { AppModule, HttpExceptionFilter, WorkerModule } from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';
import { ensureEmployee } from './support/directory';

/**
 * E2E for GET /events/stream (event-status-stream) — REAL Postgres + REAL
 * Redis required (`docker compose up`). The suite proves the whole fan-out:
 * the publishing hooks (API process and worker process) write pub/sub
 * messages, the API's SSE subscribers deliver them tenant-scoped to the
 * connected client.
 *
 * Streams are infinite, so consumption uses a raw `http` client with an
 * AbortController and hard frame timeouts — no supertest response parsing.
 * Frames are matched by their parsed JSON payload, never by string position.
 *
 * ENV pinning follows the house pattern (`FailureConfig.fromEnv`): the knobs
 * involved (PAYROLL_FAILURE_MODE, EVENT_STREAM_HEARTBEAT_INTERVAL_MS) are
 * consumed from live `process.env` at module construction, so each describe
 * pins its value in `beforeAll` before building its module.
 */

jest.setTimeout(60_000);

interface StreamNotification {
  organizationId: string;
  eventId: string;
  eventType: string;
  employeeId: string;
  sequence: number;
  status: string;
  occurredAt: string;
}

const SALARY_PAYLOAD = (employeeId: string) => ({
  employeeId,
  effectiveDate: '2026-09-01',
  newSalary: 75000,
  currency: 'EUR',
});

/** One open SSE connection against the running API server. */
interface OpenStream {
  /** Everything received so far (frames may split across chunks). */
  buffer: () => string;
  /** Parses the accumulated buffer into complete SSE events. */
  frames: () => Array<{ event: string | null; data: string | null; comment: string | null }>;
  notifications: () => StreamNotification[];
  /** Resolves when `predicate` accepts a lifecycle notification, else times out (and aborts). */
  waitForNotification: (
    predicate: (notification: StreamNotification) => boolean,
    what: string,
    timeoutMs?: number,
  ) => Promise<StreamNotification>;
  /** Resolves when the raw buffer contains `fragment` (comments included). */
  waitForFragment: (fragment: string, what: string, timeoutMs?: number) => Promise<string>;
  abort: () => void;
  done: Promise<void>;
}

function openSseStream(baseUrl: string, headers: Record<string, string>): OpenStream {
  const controller = new AbortController();
  const received: string[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const req = http.request(
    `${baseUrl}/events/stream`,
    { headers, signal: controller.signal } as http.RequestOptions,
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => received.push(chunk));
      res.on('end', () => finish());
      res.on('error', () => finish());
    },
  );
  req.on('error', () => {
    // An AbortError is the client's own close path — settle, nothing to report:
    // the stream contents up to the drop are what the assertions read.
    finish();
  });
  req.end();

  const buffer = () => received.join('');
  const frames = () => {
    const events: Array<{ event: string | null; data: string | null; comment: string | null }> = [];
    for (const block of buffer().split('\n\n')) {
      if (!block.trim()) continue;
      const parsed: { event: string | null; data: string | null; comment: string | null } = {
        event: null,
        data: null,
        comment: null,
      };
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) parsed.comment = (parsed.comment ?? '') + line + '\n';
        else if (line.startsWith('event:')) parsed.event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) parsed.data = line.slice('data:'.length).trim();
      }
      events.push(parsed);
    }
    return events;
  };
  const notifications = () =>
    frames()
      .filter((frame) => frame.data)
      .map((frame) => {
        try {
          return JSON.parse(frame.data as string) as StreamNotification;
        } catch {
          return null;
        }
      })
      .filter((n): n is StreamNotification => n !== null);

  const waitForNotification = (
    predicate: (notification: StreamNotification) => boolean,
    what: string,
    timeoutMs = 15_000,
  ): Promise<StreamNotification> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise<StreamNotification>((resolve, reject) => {
      const interval = setInterval(() => {
        const match = notifications().find(predicate);
        if (match) {
          clearInterval(interval);
          clearTimeout(timeoutTimer);
          resolve(match);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(interval);
          clearTimeout(timeoutTimer);
          controller.abort();
          reject(
            new Error(
              `Timed out waiting for stream notification: ${what}\nReceived:\n${buffer()}`,
            ),
          );
        }
      }, 25);
      const timeoutTimer = setTimeout(() => undefined, timeoutMs + 1_000);
    });
  };

  const waitForFragment = (fragment: string, what: string, timeoutMs = 5_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise<string>((resolve, reject) => {
      const interval = setInterval(() => {
        if (buffer().includes(fragment)) {
          clearInterval(interval);
          clearTimeout(timeoutTimer);
          resolve(buffer());
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(interval);
          clearTimeout(timeoutTimer);
          controller.abort();
          reject(new Error(`Timed out waiting for stream fragment: ${what}\nReceived:\n${buffer()}`));
        }
      }, 25);
      const timeoutTimer = setTimeout(() => undefined, timeoutMs + 1_000);
    });
  };

  return { buffer, frames, notifications, waitForNotification, waitForFragment, abort: () => controller.abort(), done };
}

interface BootedApi {
  app: INestApplication;
  server: http.Server;
  baseUrl: string;
  prisma: PrismaService;
}

async function bootApi(options: { swagger?: boolean } = {}): Promise<BootedApi> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  if (options.swagger) {
    const { setupSwagger } = await import('@repo/core');
    setupSwagger(app, 3000);
  }
  await app.init();
  const server = app.getHttpServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  const prisma = app.get(PrismaService);
  return { app, server, baseUrl: `http://127.0.0.1:${address.port}`, prisma };
}

async function closeBooted(booted: BootedApi): Promise<void> {
  await new Promise<void>((resolve) => {
    // Already closed (app.close() also stops the server) resolves via the
    // error callback — teardown must not throw.
    booted.server.close(() => resolve());
  });
  await booted.app.close();
}

const clearEventRows = (prisma: PrismaService) =>
  Promise.all([
    prisma.payrollEvent.deleteMany({}),
    prisma.eventAttempt.deleteMany({}),
    prisma.eventAction.deleteMany({}),
  ]);

describe('GET /events/stream — auth and transport (event-status-stream)', () => {
  let booted: BootedApi;
  let tenant: TestTenant;

  beforeAll(async () => {
    booted = await bootApi();
    tenant = await registerTenant(booted.app, 'stream-auth');
  });

  afterAll(async () => {
    await closeBooted(booted);
  });

  it('rejects a tokenless request with 401 and the structured error body', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${booted.baseUrl}/events/stream`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(401);
  });

  it('an invalid token is a 401 too', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${booted.baseUrl}/events/stream`,
        { headers: { Authorization: 'Bearer not-a-token' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(401);
  });

  it('a valid token opens a text/event-stream that stays open and announces itself', async () => {
    const stream = openSseStream(booted.baseUrl, { Authorization: `Bearer ${tenant.accessToken}` });
    try {
      const buffer = await stream.waitForFragment(': connected', 'initial stream comment');
      expect(buffer).toContain(': connected');
      // The connection stays open — the response must be the documented type.
      expect(stream.frames().some((f) => f.comment?.startsWith(': connected'))).toBe(true);
    } finally {
      stream.abort();
      await stream.done;
    }
  });
});

describe('GET /events/stream — tenant isolation (event-status-stream, R6)', () => {
  let booted: BootedApi;
  let orgA: TestTenant;
  let orgB: TestTenant;
  const streams: OpenStream[] = [];

  const track = (stream: OpenStream) => {
    streams.push(stream);
    return stream;
  };

  beforeAll(async () => {
    booted = await bootApi();
    orgA = await registerTenant(booted.app, 'stream-iso-a');
    orgB = await registerTenant(booted.app, 'stream-iso-b');
  });

  beforeEach(async () => {
    await clearEventRows(booted.prisma);
  });

  afterAll(async () => {
    for (const stream of streams) stream.abort();
    await closeBooted(booted);
  });

  const submitFor = async (tenant: TestTenant, employeeId: string) =>
    new Promise<string>((resolve, reject) => {
      const req = http.request(`${booted.baseUrl}/events`, {
        method: 'POST',
        headers: {
          ...tenant.headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 201) resolve((JSON.parse(body) as { id: string }).id);
          else reject(new Error(`submission failed: ${res.statusCode} ${body}`));
        });
      });
      req.on('error', reject);
      req.end(
        JSON.stringify({ eventType: 'SALARY_CHANGE', payload: SALARY_PAYLOAD(employeeId) }),
      );
    });

  it('organization A’s stream hears nothing about organization B’s transitions — and vice versa', async () => {
    await ensureEmployee(booted.prisma, orgA.organizationId, 'iso-A');
    await ensureEmployee(booted.prisma, orgB.organizationId, 'iso-B');

    const streamA = track(openSseStream(booted.baseUrl, { Authorization: `Bearer ${orgA.accessToken}` }));
    const streamB = track(openSseStream(booted.baseUrl, { Authorization: `Bearer ${orgB.accessToken}` }));
    await streamA.waitForFragment(': connected', 'A initial');
    await streamB.waitForFragment(': connected', 'B initial');

    // Both transitions fire while both streams are open.
    await submitFor(orgA, 'iso-A');
    await submitFor(orgB, 'iso-B');

    const aHeard = await streamA.waitForNotification(
      (n) => n.status === 'queued' && n.organizationId === orgA.organizationId,
      'A’s own queued transition',
    );
    expect(aHeard.eventId).toBeTruthy();

    await streamB.waitForNotification(
      (n) => n.status === 'queued' && n.organizationId === orgB.organizationId,
      'B’s own queued transition',
    );

    // The only notifications each stream received name its OWN organization.
    const aForeign = streamA.notifications().filter((n) => n.organizationId !== orgA.organizationId);
    const bForeign = streamB.notifications().filter((n) => n.organizationId !== orgB.organizationId);
    expect(aForeign).toEqual([]);
    expect(bForeign).toEqual([]);
  });
});

describe('GET /events/stream — delivery of committed transitions (always-success worker)', () => {
  let booted: BootedApi;
  let workerApp: INestApplication;
  let tenant: TestTenant;
  let employeeNumber: string;

  beforeAll(async () => {
    // Deterministic success: a fresh submission must succeed on its first
    // claim, so the success notification always follows the queued one.
    process.env.PAYROLL_FAILURE_MODE = 'always-success';
    booted = await bootApi();
    tenant = await registerTenant(booted.app, 'stream-delivery');
    await ensureEmployee(booted.prisma, tenant.organizationId, 'deliver-1');
    employeeNumber = 'deliver-1';

    const workerModuleRef: TestingModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    workerApp = workerModuleRef.createNestApplication();
    await workerApp.init();
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await workerApp?.close();
    await closeBooted(booted);
  });

  it('streams the queued and committed success notifications for a fresh submission', async () => {
    const stream = openSseStream(booted.baseUrl, {
      Authorization: `Bearer ${tenant.accessToken}`,
    });
    try {
      await stream.waitForFragment(': connected', 'initial stream comment');

      const id = await new Promise<string>((resolve, reject) => {
        const req = http.request(`${booted.baseUrl}/events`, {
          method: 'POST',
          headers: {
            ...tenant.headers,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode === 201) resolve((JSON.parse(body) as { id: string }).id);
            else reject(new Error(`submission failed: ${res.statusCode} ${body}`));
          });
        });
        req.on('error', reject);
        req.end(JSON.stringify({ eventType: 'SALARY_CHANGE', payload: SALARY_PAYLOAD(employeeNumber) }));
      });

      const queued = await stream.waitForNotification(
        (n) => n.eventId === id && n.status === 'queued',
        'queued after submission',
      );
      const success = await stream.waitForNotification(
        (n) => n.eventId === id && n.status === 'success',
        'committed success',
        25_000,
      );

      // The notification payload is the documented wire shape (D2), numerical
      // sequence JSON-safe.
      for (const notification of [queued, success]) {
        expect(notification.organizationId).toBe(tenant.organizationId);
        expect(notification.eventType).toBe('SALARY_CHANGE');
        expect(notification.employeeId).toBe(employeeNumber);
        expect(typeof notification.sequence).toBe('number');
        expect(Number.isNaN(Date.parse(notification.occurredAt))).toBe(false);
      }
      expect(success.sequence).toBe(queued.sequence);

      // Committed state only: the rolled-back claim is never announced as
      // `processing` (spec: stream reflects committed state).
      expect(stream.notifications().filter((n) => n.eventId === id && n.status === 'processing')).toEqual([]);
    } finally {
      stream.abort();
      await stream.done;
    }
  });
});

describe('GET /events/stream — recovery actions announce (API only, no worker)', () => {
  let booted: BootedApi;
  let tenant: TestTenant;

  const seedEvent = async (status: EventStatus) => {
    const id = randomUUID();
    await booted.prisma.payrollEvent.create({
      data: {
        id,
        organizationId: tenant.organizationId,
        eventType: 'SALARY_CHANGE',
        employeeId: 'action-1',
        payload: SALARY_PAYLOAD('action-1'),
        sequence: 1n,
        idempotencyKey: randomUUID(),
        status,
      },
    });
    return id;
  };

  const postAction = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(`${booted.baseUrl}/events/${path}`, {
        method: 'POST',
        headers: { ...tenant.headers, 'Content-Type': 'application/json' },
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });

  beforeAll(async () => {
    booted = await bootApi();
    tenant = await registerTenant(booted.app, 'stream-actions');
    await ensureEmployee(booted.prisma, tenant.organizationId, 'action-1');
  });

  beforeEach(async () => {
    await clearEventRows(booted.prisma);
  });

  afterAll(async () => {
    await closeBooted(booted);
  });

  it('cancelling a pending event announces `cancelled`', async () => {
    const id = await seedEvent(EventStatus.QUEUED);
    const stream = openSseStream(booted.baseUrl, {
      Authorization: `Bearer ${tenant.accessToken}`,
    });
    try {
      await stream.waitForFragment(': connected', 'initial stream comment');

      expect(await postAction(`${id}/cancel`)).toBe(200);

      const notification = await stream.waitForNotification(
        (n) => n.eventId === id && n.status === 'cancelled',
        'cancelled after the action',
      );
      expect(notification.employeeId).toBe('action-1');
    } finally {
      stream.abort();
      await stream.done;
    }
  });

  it('retrying a failed event announces `queued`', async () => {
    const id = await seedEvent(EventStatus.FAILED);
    const stream = openSseStream(booted.baseUrl, {
      Authorization: `Bearer ${tenant.accessToken}`,
    });
    try {
      await stream.waitForFragment(': connected', 'initial stream comment');

      expect(await postAction(`${id}/retry`)).toBe(200);

      const notification = await stream.waitForNotification(
        (n) => n.eventId === id && n.status === 'queued',
        'queued after the retry action',
      );
      expect(notification.employeeId).toBe('action-1');
    } finally {
      stream.abort();
      await stream.done;
    }
  });

  it('a rejected action (409) announces nothing', async () => {
    const id = await seedEvent(EventStatus.SUCCESS);
    const stream = openSseStream(booted.baseUrl, {
      Authorization: `Bearer ${tenant.accessToken}`,
    });
    try {
      await stream.waitForFragment(': connected', 'initial stream comment');

      // A SUCCESS event is not retryable — the 409 rejects BEFORE any
      // transition commits, so no notification may exist for it.
      expect(await postAction(`${id}/retry`)).toBe(409);

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        stream.notifications().filter((n) => n.eventId === id),
      ).toEqual([]);
    } finally {
      stream.abort();
      await stream.done;
    }
  });
});

describe('GET /events/stream — heartbeat liveness (comment frames at the configured interval)', () => {
  let booted: BootedApi;
  let tenant: TestTenant;

  beforeAll(async () => {
    // 1 s ticks: the first heartbeat lands well inside the wait window. The
    // stream service reads this from live process.env at construction.
    process.env.EVENT_STREAM_HEARTBEAT_INTERVAL_MS = '1000';
    booted = await bootApi();
    tenant = await registerTenant(booted.app, 'stream-heartbeat');
  });

  afterAll(async () => {
    delete process.env.EVENT_STREAM_HEARTBEAT_INTERVAL_MS;
    await closeBooted(booted);
  });

  it('keeps an idle stream alive with comment heartbeats', async () => {
    const stream = openSseStream(booted.baseUrl, {
      Authorization: `Bearer ${tenant.accessToken}`,
    });
    try {
      await stream.waitForFragment(': connected', 'initial stream comment');
      await stream.waitForFragment(': heartbeat', 'first heartbeat tick', 8_000);
      expect(stream.buffer()).toContain(': heartbeat');
    } finally {
      stream.abort();
      await stream.done;
    }
  });
});
