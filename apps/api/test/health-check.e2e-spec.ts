import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule, HttpExceptionFilter, setupSwagger } from '@repo/core';
import { PrismaService } from '@repo/database';

/**
 * E2E for the worker-liveness surface of GET /health (design D4) — REAL
 * Postgres + REAL Redis required (`docker compose up`). The API-only AppModule
 * is booted (no WorkerModule) so the heartbeat rows this suite writes are not
 * overwritten by a live worker; /health reads `worker_heartbeats` directly.
 */
jest.setTimeout(30_000);

describe('GET /health — worker liveness (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
    setupSwagger(app, 3000);
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.workerHeartbeat.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
    await prisma.workerHeartbeat.deleteMany({}).catch(() => undefined);
  });

  const http = () => request(app.getHttpServer());

  it('returns ok with an empty workers list and a stalled count', async () => {
    const res = await http().get('/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(res.body.redis).toBe('ok');
    expect(Array.isArray(res.body.workers)).toBe(true);
    expect(res.body.workers).toHaveLength(0);
    expect(typeof res.body.stalled).toBe('number');
    expect(res.body.stalled).toBeGreaterThanOrEqual(0);
  });

  it('reports a fresh heartbeat as a non-stale worker', async () => {
    await prisma.workerHeartbeat.create({
      data: {
        workerId: 'e2e-worker-1',
        hostname: 'e2e-host',
        startedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    const res = await http().get('/health').expect(200);

    const worker = res.body.workers.find(
      (w: { workerId: string }) => w.workerId === 'e2e-worker-1',
    );
    expect(worker).toBeDefined();
    expect(worker.hostname).toBe('e2e-host');
    expect(worker.lastSeenAt).toBeDefined();
    expect(worker.stale).toBe(false);
    expect(res.body.status).toBe('ok');
  });

  it('degrades when a worker heartbeat is stale (older than HEALTH_WORKER_STALE_MS)', async () => {
    const old = new Date(Date.now() - 60_000); // 60s old > 15s default
    await prisma.workerHeartbeat.create({
      data: {
        workerId: 'e2e-worker-stale',
        hostname: 'e2e-host',
        startedAt: old,
        lastSeenAt: old,
      },
    });

    const res = await http().get('/health').expect(200);

    expect(res.body.status).toBe('degraded');
    const worker = res.body.workers.find(
      (w: { workerId: string }) => w.workerId === 'e2e-worker-stale',
    );
    expect(worker.stale).toBe(true);
  });

  it('documents the extended HealthResponseDto (workers + stalled) in OpenAPI', async () => {
    const doc = (await http().get('/api-docs-json').expect(200)).body;

    const schema = doc.components.schemas['HealthResponseDto'];
    expect(schema).toBeDefined();

    const props = schema.properties;
    expect(props.workers).toBeDefined();
    expect(props.workers.type).toBe('array');
    expect(props.stalled).toBeDefined();
    expect(props.stalled.type).toBe('number');
    expect(schema.required).toContain('workers');
    expect(schema.required).toContain('stalled');
  });
});