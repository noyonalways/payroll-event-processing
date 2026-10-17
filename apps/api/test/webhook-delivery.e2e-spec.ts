import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { createHmac } from 'crypto';
import {
  AppModule,
  EventClaim,
  HttpExceptionFilter,
  ProcessingModule,
  WebhookHttpClient,
  WebhookRelayService,
} from '@repo/core';
import { PrismaService } from '@repo/database';
import { TestTenant, registerTenant } from './support/auth';

/**
 * Full-path webhook delivery e2e (integrator-webhooks) — REAL Postgres + the
 * REAL relay HTTP client (node fetch) against a stub receiver on 127.0.0.1.
 *
 * Pipeline: register endpoint (secret returned once) → submit an event → drive
 * the REAL claim transaction (`EventClaim`, worker-disabled pattern from
 * domain-state.e2e) → the outbox intent commits with the terminal state →
 * `WebhookRelayService.processDueOnce()` delivers to the stub → the stub
 * VERIFIES the HMAC-SHA256 signature over the raw bytes with the create-time
 * secret. Failure scenarios: 503-then-200 exercises transient backoff +
 * redelivery, 410 dead-letters with the rejection recorded — and in every
 * failure case the event's terminal state and attempt trail stay untouched.
 */
jest.setTimeout(60_000);

const DEMO_EMPLOYEE_SEEDS = [
  { employeeNumber: 'EMP-DEMO-SUCCESS', name: 'Demo employee (success)' },
  { employeeNumber: 'EMP-DEMO-RECOVER', name: 'Demo employee (recover)' },
  { employeeNumber: 'EMP-DEMO-TRANSIENT', name: 'Demo employee (transient)' },
  { employeeNumber: 'EMP-DEMO-FAILAFTER', name: 'Demo employee (fail-after-retries)' },
  { employeeNumber: 'EMP-DEMO-PERMANENT', name: 'Demo employee (permanent)' },
];
const SUCCESS_EMPLOYEE = 'EMP-DEMO-SUCCESS';
const DEMO_EMPLOYEE_DEPARTMENT = 'Demo';

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
}

/** Programmable HTTP stub: captures requests, answers from a response queue. */
class StubReceiver {
  private server!: http.Server;
  private requestQueue: Array<{ status: number; body?: string }> = [];
  readonly captured: CapturedRequest[] = [];
  port = 0;

  private constructor() {}

  /** Binds an ephemeral 127.0.0.1 listener; port is valid once this resolves. */
  static async start(): Promise<StubReceiver> {
    const stub = new StubReceiver();
    await new Promise<void>((resolve, reject) => {
      stub.server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          stub.captured.push({
            url: req.url ?? '/',
            headers: req.headers,
            rawBody: Buffer.concat(chunks),
          });
          const next =
            stub.requestQueue.length > 1
              ? stub.requestQueue.shift()!
              : (stub.requestQueue[0] ?? { status: 200 });
          res.statusCode = next.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(next.body ?? '{}');
        });
      });
      // listen() is async: the port only exists at the 'listening' event.
      stub.server.once('listening', () => resolve());
      stub.server.once('error', (error) => reject(error));
      stub.server.listen(0, '127.0.0.1');
    });
    stub.port = (stub.server.address() as AddressInfo).port;
    return stub;
  }

  /** Programs responses for the NEXT requests (last entry repeats forever). */
  respondWith(...responses: Array<{ status: number; body?: string }>): void {
    this.requestQueue = [...responses];
  }

  get urlBase(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  reset(): void {
    this.captured.length = 0;
    this.requestQueue = [];
  }

  close(): void {
    this.server.close();
  }
}

// A fake ConfigService for the relay (only the numeric knobs are read).
const relayConfig = {
  get: jest.fn((key: string) =>
    ({
      WEBHOOK_RELAY_INTERVAL_MS: 5_000,
      WEBHOOK_RELAY_BATCH_SIZE: 10,
      WEBHOOK_RELAY_MAX_ATTEMPTS: 8,
      WEBHOOK_DELIVERY_TIMEOUT_MS: 10_000,
    })[key as string],
  ),
};

describe('Webhook delivery full path (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let eventClaim: EventClaim;
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let stub: StubReceiver;

  beforeAll(async () => {
    process.env.PAYROLL_FAILURE_MODE = 'always-success';
    stub = await StubReceiver.start();

    // API-only boot (worker disabled pattern, domain-state.e2e): submitted
    // events stay `queued` and the real claim is driven directly. The real
    // relay is constructed below with the REAL fetch client against the stub.
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
    eventClaim = app.get(EventClaim);
    tenant = await registerTenant(app, 'hook-flow');
    otherTenant = await registerTenant(app, 'hook-flow-other');
    await seedScenarioEmployees();
  });

  beforeEach(async () => {
    // Cross-run hygiene: a prior aborted battery can leave PENDING rows whose
    // stub receiver is long gone — they would pollute the due set.
    await prisma.webhookDeliveryAttempt.deleteMany({});
    await prisma.webhookDelivery.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await app?.close();
    stub.close();
    await prisma.webhookDeliveryAttempt.deleteMany({}).catch(() => undefined);
    await prisma.webhookDelivery.deleteMany({}).catch(() => undefined);
    await prisma.webhookEndpoint.deleteMany({}).catch(() => undefined);
  });

  const seedScenarioEmployees = async () =>
    prisma.employee.createMany({
      data: DEMO_EMPLOYEE_SEEDS.map((seed) => ({
        organizationId: tenant.organizationId,
        ...seed,
        department: DEMO_EMPLOYEE_DEPARTMENT,
      })),
      skipDuplicates: true,
    });

  const submitSalary = async (amount = 81_000) => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .set(tenant.headers)
      .set('Idempotency-Key', `hooks-e2e-${Date.now()}-${Math.random()}`)
      .send({
        eventType: 'SALARY_CHANGE',
        payload: {
          employeeId: SUCCESS_EMPLOYEE,
          effectiveDate: '2026-10-01',
          newSalary: amount,
          currency: 'EUR',
        },
      });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const submitTo = async (as: TestTenant, employeeNumber: string) => {
    await prisma.employee.createMany({
      data: DEMO_EMPLOYEE_SEEDS.map((seed) => ({
        organizationId: as.organizationId,
        ...seed,
        department: DEMO_EMPLOYEE_DEPARTMENT,
      })),
      skipDuplicates: true,
    });
    const res = await request(app.getHttpServer())
      .post('/events')
      .set(as.headers)
      .set('Idempotency-Key', `hooks-e2e-${Date.now()}-${Math.random()}`)
      .send({
        eventType: 'SALARY_CHANGE',
        payload: {
          employeeId: employeeNumber,
          effectiveDate: '2026-10-01',
          newSalary: 50_000,
          currency: 'EUR',
        },
      });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const waitForQueued = async (id: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = await prisma.payrollEvent.findFirst({ where: { id } });
      if (found?.status === 'QUEUED') return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for the event to reach queued');
  };

  /** Claim directly (real claim tx incl. the outbox write). */
  const processEvent = async (id: string) => {
    const row = await waitForQueued(id);
    const outcome = await eventClaim.claimAndProcess({
      eventId: row.id,
      organizationId: row.organizationId,
      eventType: row.eventType,
      employeeId: row.employeeId,
      sequence: Number(row.sequence),
      attempt: (row.attemptBase ?? 0) + 1,
    });
    return { row, outcome };
  };

  const soleDelivery = async (eventId: string) => {
    const deliveries = await prisma.webhookDelivery.findMany({ where: { eventId } });
    expect(deliveries).toHaveLength(1);
    return deliveries[0];
  };

  const makeDue = async (deliveryId: string) => {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAt: new Date(Date.now() - 1) },
    });
  };

  let endpointId: string;
  let signingSecret: string;

  it('registers the endpoint and hands the secret out exactly once', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhook-endpoints')
      .set(tenant.headers)
      .send({ label: 'stub', url: `${stub.urlBase}/hooks` });
    expect(res.status).toBe(201);
    endpointId = res.body.id;
    signingSecret = res.body.signingSecret;
    expect(signingSecret).toBeDefined();
  });

  it('delivers a signed notification for a terminal success commit', async () => {
    stub.respondWith({ status: 200 });
    const submitted = await submitSalary();
    const { outcome } = await processEvent(submitted.id);
    expect(outcome).toMatchObject({ outcome: 'success' });

    // The intent committed with the terminal state (same tx).
    const delivery = await soleDelivery(submitted.id);
    expect(delivery).toMatchObject({
      webhookEndpointId: endpointId,
      terminalStatus: 'SUCCESS',
      status: 'PENDING',
      url: `${stub.urlBase}/hooks`,
      organizationId: tenant.organizationId,
    });
    const payload = delivery.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      eventId: submitted.id,
      organizationId: tenant.organizationId,
      employeeId: SUCCESS_EMPLOYEE,
      status: 'SUCCESS',
      deliveryId: delivery.id,
    });

    const processed = await relay().processDueOnce();
    expect(processed).toEqual([delivery.id]);

    // The stub received a POST whose HMAC verifies against the create-time
    // secret over the EXACT raw bytes, with identity headers intact.
    expect(stub.captured).toHaveLength(1);
    const hit = stub.captured[0];
    const expectedSig =
      'sha256=' + createHmac('sha256', signingSecret).update(hit.rawBody).digest('hex');
    expect(hit.headers['x-payroll-signature']).toBe(expectedSig);
    expect(hit.headers['x-payroll-event']).toBe(submitted.id);
    expect(hit.headers['x-payroll-delivery']).toBe(delivery.id);
    const deliveredPayload = JSON.parse(hit.rawBody.toString('utf8'));
    expect(deliveredPayload).toMatchObject({
      eventId: submitted.id,
      status: 'SUCCESS',
      employeeId: SUCCESS_EMPLOYEE,
      eventType: 'SALARY_CHANGE',
    });
    expect(String(deliveredPayload.result?.reference ?? '')).not.toBe('');

    const after = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(after).toMatchObject({
      status: 'DELIVERED',
      attempts: 1,
      deadLetterReason: null,
    });
    expect(after?.deliveredAt).toBeTruthy();
    const trail = await prisma.webhookDeliveryAttempt.findMany({
      where: { deliveryId: delivery.id },
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ attemptNumber: 1, outcome: 'DELIVERED', responseStatus: 200 });
  });

  it('survives a temporary endpoint outage: 503 → backoff → 200 redelivery', async () => {
    const submitted = await submitSalary(82_000);
    await processEvent(submitted.id);
    let delivery = await soleDelivery(submitted.id);
    stub.reset();
    // First delivery fails transiently: PENDING, backoff scheduled, attempt recorded.
    stub.respondWith({ status: 503 }, { status: 200 });
    await relay().processDueOnce();
    delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(delivery).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Force due (an actual relay waits the backoff out) and redeliver: 200.
    await makeDue(delivery.id);
    await relay().processDueOnce();
    delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(delivery).toMatchObject({ status: 'DELIVERED', attempts: 2 });

    const trail = await prisma.webhookDeliveryAttempt.findMany({
      where: { deliveryId: delivery.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(trail.map((a) => [a.attemptNumber, a.outcome, a.responseStatus])).toEqual([
      [1, 'FAILED', 503],
      [2, 'DELIVERED', 200],
    ]);
  });

  it('dead-letters on a permanent rejection without retrying, event untouched', async () => {
    stub.respondWith({ status: 410, body: 'gone forever' });
    const submitted = await submitSalary(83_000);
    const { row } = await processEvent(submitted.id);
    const delivery = await soleDelivery(submitted.id);

    await relay().processDueOnce();

    const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(after).toMatchObject({
      status: 'DEAD_LETTERED',
      deadLetterReason: 'endpoint_rejected',
      attempts: 1,
      nextAttemptAt: null,
    });
    const trail = await prisma.webhookDeliveryAttempt.findMany({
      where: { deliveryId: delivery.id },
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ outcome: 'FAILED', responseStatus: 410 });

    // The event's committed terminal state and attempt trail are UNCHANGED.
    const event = await prisma.payrollEvent.findFirstOrThrow({ where: { id: submitted.id } });
    expect(event.status).toBe('SUCCESS');
    expect(event.processedAt).toBeTruthy();
    const attempts = await prisma.eventAttempt.findMany({ where: { eventId: row.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'SUCCESS', attemptNumber: 1 });
  });

  it('produces no intents for organizations without endpoints', async () => {
    const submitted = await submitTo(otherTenant, 'EMP-DEMO-SUCCESS');
    await processEvent(submitted.id);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { eventId: submitted.id },
    });
    expect(deliveries).toHaveLength(0);
  });

  it('deliveries stay tenant-scoped over the read API', async () => {
    // Self-contained: the beforeEach cleanup wipes earlier tests' deliveries.
    const endpoint = await prisma.webhookEndpoint.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
      select: { id: true, url: true },
    });
    const inserted = {
      id: `deliver-${randomUUID()}`,
      eventId: `evt-${randomUUID()}`,
    };
    await prisma.webhookDelivery.create({
      data: {
        id: inserted.id,
        organizationId: tenant.organizationId,
        webhookEndpointId: endpoint.id,
        eventId: inserted.eventId,
        terminalStatus: 'SUCCESS',
        url: endpoint.url,
        payload: { eventId: inserted.eventId, status: 'SUCCESS' },
        status: 'DELIVERED',
        attempts: 1,
        deliveredAt: new Date(),
      },
    });
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { organizationId: tenant.organizationId },
      take: 1,
    });
    expect(deliveries.length).toBeGreaterThan(0);

    const read = await request(app.getHttpServer())
      .get(`/webhook-deliveries/${inserted.id}`)
      .set(otherTenant.headers);
    expect(read.status).toBe(404);

    const endpointRead = await request(app.getHttpServer())
      .get(`/webhook-endpoints/${endpointId}/deliveries`)
      .set(otherTenant.headers);
    expect(endpointRead.status).toBe(404);
  });

  /** Relay under test: the app's Prisma + REAL fetch client against the stub. */
  function relay() {
    return new WebhookRelayService(
      prisma,
      new WebhookHttpClient(),
      { recordWebhookDelivery: jest.fn(), recordAttempt: jest.fn() } as never,
      relayConfig as never,
    );
  }
});
