import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import {
  AppModule,
  EventClaim,
  HttpExceptionFilter,
  ProcessingModule,
} from '@repo/core';
import { PrismaService } from '@repo/database';
import { TransientPayrollFailureError } from '@repo/shared';
import { TestTenant, registerTenant } from './support/auth';

/**
 * Full-path HTTP-provider e2e (real-provider-adapter): org configures an
 * external endpoint (a local stub receiver) → submit → REAL claim transaction
 * → the handler dispatches through the HTTP adapter → the stub receives the
 * documented contract (body + Authorization header) → event commits `success`
 * with the payer's own reference. Failure modes: 503 → transient (claim rolls
 * back, event stays queued, NO domain state) then success on a manual retry;
 * 422 → permanent `failed` with the FAILED(PERMANENT) attempt row. Switching
 * the config back to SIMULATED resolves the simulated provider again —
 * without a restart (spec scenario: resolution re-read per operation).
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

interface CapturedProviderCall {
  url: string;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
}

/** Programmable stub provider: captures calls, answers from a queue. */
class StubProvider {
  private server!: http.Server;
  private responses: Array<{ status: number; body: Record<string, unknown> }> = [];
  readonly captured: CapturedProviderCall[] = [];
  port = 0;

  private constructor() {}

  static async start(): Promise<StubProvider> {
    const stub = new StubProvider();
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
            stub.responses.length > 1
              ? stub.responses.shift()!
              : (stub.responses[0] ?? { status: 200, body: { reference: 'ext-default' } });
          res.statusCode = next.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(next.body));
        });
      });
      stub.server.once('listening', () => resolve());
      stub.server.once('error', (error) => reject(error));
      stub.server.listen(0, '127.0.0.1');
    });
    stub.port = (stub.server.address() as AddressInfo).port;
    return stub;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/effects`;
  }

  respondWith(...responses: Array<{ status: number; body: Record<string, unknown> }>): void {
    this.responses = [...responses];
  }

  reset(): void {
    this.captured.length = 0;
    this.responses = [];
  }

  close(): void {
    this.server.close();
  }
}

describe('HTTP provider processing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let eventClaim: EventClaim;
  let tenant: TestTenant;
  let stubInstance: StubProvider;

  beforeAll(async () => {
    process.env.PAYROLL_FAILURE_MODE = 'always-success';
    stubInstance = await StubProvider.start();

    // API-only boot (worker-disabled pattern): events stay queued and claims
    // are driven directly through the REAL claim transaction.
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
    tenant = await registerTenant(app, 'provider-flow');
    await prisma.employee.createMany({
      data: DEMO_EMPLOYEE_SEEDS.map((seed) => ({
        organizationId: tenant.organizationId,
        ...seed,
        department: DEMO_EMPLOYEE_DEPARTMENT,
      })),
      skipDuplicates: true,
    });
  });

  beforeEach(async () => {
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
    await prisma.employeeDomainState.deleteMany({}).catch(() => undefined);
    await prisma.eventAttempt.deleteMany({}).catch(() => undefined);
    await prisma.webhookDeliveryAttempt.deleteMany({}).catch(() => undefined);
    await prisma.webhookDelivery.deleteMany({}).catch(() => undefined);
    await prisma.providerConfig.deleteMany({}).catch(() => undefined);
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await app?.close();
    stubInstance?.close();
  });

  const submitSalary = async (amount = 91000) => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .set(tenant.headers)
      .set('Idempotency-Key', `provider-e2e-${randomUUID()}`)
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

  const waitForQueued = async (id: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = await prisma.payrollEvent.findFirst({ where: { id } });
      if (found?.status === 'QUEUED') return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for the event to reach queued');
  };

  const claim = async (id: string, attempt: number) => {
    const row = await waitForQueued(id);
    return eventClaim.claimAndProcess({
      eventId: row.id,
      organizationId: row.organizationId,
      eventType: row.eventType,
      employeeId: row.employeeId,
      sequence: Number(row.sequence),
      attempt: (row.attemptBase ?? 0) + attempt,
    });
  };

  const configureHttp = async () => {
    const res = await request(app.getHttpServer())
      .put('/provider-config')
      .set(tenant.headers)
      .send({ mode: 'HTTP', baseUrl: stubInstance.baseUrl, credential: 'ext-cred-1' });
    expect(res.status).toBe(201);
  };

  const configureSimulated = async () => {
    const res = await request(app.getHttpServer())
      .put('/provider-config')
      .set(tenant.headers)
      .send({ mode: 'SIMULATED' });
    expect(res.status).toBe(201);
  };

  it('processes through the HTTP adapter and commits the external reference', async () => {
    await configureHttp();
    stubInstance.respondWith({ status: 200, body: { reference: 'ext-777' } });

    const submitted = await submitSalary();
    const outcome = await claim(submitted.id, 1);

    expect(outcome).toMatchObject({ outcome: 'success', reference: 'ext-777' });

    // The stub received the documented contract (body + Authorization).
    expect(stubInstance.captured).toHaveLength(1);
    const call = stubInstance.captured[0];
    expect(call.url).toBe('/effects');
    expect(call.headers.authorization).toBe('Bearer ext-cred-1');
    const body = JSON.parse(call.rawBody.toString('utf8'));
    expect(body).toMatchObject({
      eventId: submitted.id,
      organizationId: tenant.organizationId,
      employeeId: SUCCESS_EMPLOYEE,
      eventType: 'SALARY_CHANGE',
      attempt: 1,
    });

    const event = await prisma.payrollEvent.findFirstOrThrow({
      where: { id: submitted.id },
    });
    expect(event.status).toBe('SUCCESS');
    const result = event.result as { reference?: string };
    expect(result.reference).toBe('ext-777');

    // The domain effect licensed by the successful external call committed.
    const state = await prisma.employeeDomainState.findFirstOrThrow({
      where: { sourceEventId: submitted.id },
    });
    expect(state.value).toMatchObject({ newSalary: 91000 });
  });

  it('a 503 is TRANSIENT: claim rolls back, event stays queued, no state, then it succeeds', async () => {
    await configureHttp();
    stubInstance.reset();
    stubInstance.respondWith({ status: 503, body: { error: 'overloaded' } });

    const submitted = await submitSalary();

    // The transient failure RE-THROWS out of the claim transaction (that IS
    // the rollback).
    await expect(claim(submitted.id, 1)).rejects.toThrow(TransientPayrollFailureError);

    const event = await prisma.payrollEvent.findFirstOrThrow({
      where: { id: submitted.id },
    });
    // The claim aborted: the row is claimable `queued` again, with NO attempt
    // row and NO domain state (the provider call precedes the state write).
    expect(event.status).toBe('QUEUED');
    expect(
      await prisma.eventAttempt.count({ where: { eventId: submitted.id } }),
    ).toBe(0);
    expect(
      await prisma.employeeDomainState.count({ where: { sourceEventId: submitted.id } }),
    ).toBe(0);

    // The queue would retry; simulate the fresh round: 200 this time.
    stubInstance.respondWith({ status: 200, body: { reference: 'ext-retry-9' } });
    const outcome = await claim(submitted.id, 2);
    expect(outcome).toMatchObject({ outcome: 'success', reference: 'ext-retry-9' });
    expect(
      await prisma.employeeDomainState.count({ where: { sourceEventId: submitted.id } }),
    ).toBe(1);
  });

  it('a 422 is PERMANENT: committed failed + FAILED(PERMANENT) attempt row, no state', async () => {
    await configureHttp();
    stubInstance.reset();
    stubInstance.respondWith({
      status: 422,
      body: { message: 'currency not supported', echo: 'ext-cred-1' },
    });

    const submitted = await submitSalary();
    const outcome = await claim(submitted.id, 1);

    expect(outcome).toMatchObject({ outcome: 'permanent-failure' });

    const event = await prisma.payrollEvent.findFirstOrThrow({
      where: { id: submitted.id },
    });
    expect(event.status).toBe('FAILED');
    const attempts = await prisma.eventAttempt.findMany({
      where: { eventId: submitted.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'FAILED', errorType: 'PERMANENT' });
    // The adapter's rejection reason is bounded; a body echoing the
    // authorization credential must be scrubbed (design D4').
    expect(attempts[0].failedReason).not.toContain('ext-cred-1');
    const state = await prisma.employeeDomainState.findFirst({
      where: { sourceEventId: submitted.id },
    });
    expect(state).toBeNull();
  });

  it('switching back to SIMULATED resolves the simulated provider — no restart', async () => {
    await configureSimulated();
    stubInstance.reset();

    const submitted = await submitSalary();
    const outcome = await claim(submitted.id, 1);

    expect(outcome).toMatchObject({ outcome: 'success' });
    expect(stubInstance.captured).toHaveLength(0);
    const result = (await prisma.payrollEvent.findFirstOrThrow({
      where: { id: submitted.id },
    })) as { result?: { reference?: string } } | null;
    // Simulated references carry their own prefix — not the external ones.
    expect(result?.result?.reference).toMatch(/^SIM-/);
  });
});
