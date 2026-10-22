import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import {
  AppModule,
  EventClaim,
  HttpExceptionFilter,
  MetricsService,
  ProcessingModule,
} from '@repo/core';
import { PrismaService } from '@repo/database';
import { registerTenant, TestTenant } from './support/auth';

/**
 * Metrics surface e2e (observability): GET /metrics is credential-free in the
 * /health posture, serves Prometheus exposition with the documented payroll_*
 * series, label values are bounded (no tenant identifiers), and the lifecycle
 * counters MOVE with a real submit→terminal cycle (deterministic failure-mode
 * provider, direct claim). Scrape errors and Redis-outage fail-softness are
 * covered at unit level (worker-metrics + registry tests sit with the module).
 */
jest.setTimeout(30_000);

describe('Prometheus metrics surface (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TestTenant;

  beforeAll(async () => {
    process.env.PAYROLL_FAILURE_MODE = 'always-success';
    // ProcessingModule pulled in deliberately (domain-state pattern): claims
    // are driven directly in-process against the worker-disabled queue.
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
    app.useGlobalFilters(new HttpExceptionFilter(app.get(MetricsService)));
    await app.init();

    prisma = app.get(PrismaService);
    tenant = await registerTenant(app, 'metrics');
  });

  afterAll(async () => {
    delete process.env.PAYROLL_FAILURE_MODE;
    await app.close();
    await prisma.payrollEvent.deleteMany({}).catch(() => undefined);
  });

  const submit = async () => {
    // The reserved `EMP-DEMO-SUCCESS` id is deterministic ALWAYS (it overrides
    // PAYROLL_FAILURE_MODE) — the bounded suite needs that, not findFirst.
    await prisma.employee.findFirstOrThrow({
      where: {
        organizationId: tenant.organizationId,
        active: true,
        employeeNumber: 'EMP-DEMO-SUCCESS',
      },
      select: { employeeNumber: true },
    });
    const res = await request(app.getHttpServer())
      .post('/events')
      .set(tenant.headers)
      .set('Idempotency-Key', `metrics-${randomUUID()}`)
      .send({
        eventType: 'SALARY_CHANGE',
        payload: {
          employeeId: 'EMP-DEMO-SUCCESS',
          effectiveDate: '2026-10-01',
          newSalary: 77_000,
          currency: 'EUR',
        },
      });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const scrape = async (): Promise<string> => {
    const res = await request(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    return res.text as string;
  };

  it('is reachable WITHOUT credentials (same posture as /health)', async () => {
    const res = await request(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(200);
    // No authorization was attached — the scrape worked bare.
  });

  it('exposes the documented lifecycle, queue, and HTTP series with bounded labels', async () => {
    const submitted = await submit();

    // Drive the REAL claim (claim → terminal commit inside one tx).
    const deadline = Date.now() + 15_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await prisma.payrollEvent.findFirst({ where: { id: submitted.id } });
      if (row?.status === 'QUEUED') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const eventClaim = app.get(EventClaim);
    const outcome = await eventClaim.claimAndProcess({
      eventId: submitted.id,
      organizationId: tenant.organizationId,
      eventType: (row as { eventType: string }).eventType,
      employeeId: (row as { employeeId: string }).employeeId,
      sequence: Number((row as { sequence: bigint }).sequence),
      attempt: 1,
    });
    expect(outcome).toMatchObject({ outcome: 'success' });

    const body = await scrape();
    for (const series of [
      'payroll_http_requests_total',
      'payroll_http_request_duration_seconds',
      'payroll_events_submitted_total',
      'payroll_events_terminal_total',
      'payroll_processing_attempts_total',
      'payroll_processing_duration_seconds',
      'payroll_queue_jobs',
      'payroll_worker_heartbeats_stale',
      'payroll_webhook_deliveries_total',
      'payroll_queue_metrics_errors_total',
    ]) {
      expect(body).toContain(series);
    }

    // The lifecycle counters MOVED with the real cycle.
    expect(body).toMatch(/payroll_events_submitted_total\{.*event_type="SALARY_CHANGE".*\}\s+\d+/);
    expect(body).toMatch(
      /payroll_events_terminal_total\{.*event_type="SALARY_CHANGE".*status="SUCCESS".*\}\s+[1-9]/,
    );
    expect(body).toMatch(/payroll_processing_attempts_total\{.*error_type="NONE".*\}\s+[1-9]/);
  });

  it('label values never contain tenant identifiers', async () => {
    const body = await scrape();
    expect(body).not.toContain(tenant.organizationId);
    expect(body).not.toContain(tenant.email);
    // Route labels are canonical patterns; a raw UUID in a label would breach
    // the cardinality ceiling.
    expect(body).not.toMatch(/route="[^(]*[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('an unauthorized-shaped request to a gated route shows as a 4xx series', async () => {
    await request(app.getHttpServer()).get('/events'); // no token → 401
    const body = await scrape();
    expect(body).toMatch(
      /payroll_http_requests_total\{.*status_class="4xx".*\}\s+[1-9]/,
    );
  });
});
