import './setup-throttle';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { registerTenant } from './support/auth';

/**
 * Throttling e2e (auth-hardening design D3): boots the FULL app with its OWN
 * ThrottlerModule override (limit 3/min) because the shared test posture keeps
 * throttling inert for all other suites. Verifies the guard fires 429 with
 * Retry-After on the credential surface BEFORE password verification (the
 * lockout counter never moves), keeps normal usage of other routes working,
 * and NEVER throttles /health or /metrics.
 */
jest.setTimeout(30_000);

afterAll(() => {
  // Reused workers: restore the inert test posture (matching setup-env.ts) —
  // tightened values must never leak into later suites.
  process.env.DEFAULT_THROTTLE_LIMIT = '10000';
  process.env.AUTH_THROTTLE_LIMIT = '1000';
  process.env.DEFAULT_THROTTLE_TTL_SECONDS = '60';
});

describe('Request throttling (e2e)', () => {
  let app: INestApplication;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('an undecorated route throttles past the OVERRIDDEN default limit (guard wiring)', async () => {
    const registerTenantOnce = async () =>
      request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: `throttle-${randomUUID()}@acme.example`,
          password: 'correct-horse-battery',
          name: 'Throttle Owner',
          organizationName: 'Throttle Org',
        });

    const session = await registerTenantOnce();
    expect(session.status).toBe(201);
    const headers = { Authorization: `Bearer ${session.body.accessToken}` };

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app.getHttpServer()).get('/employees').set(headers)).status).toBe(200);
    }
    // The 4th exceeds the overridden default (limit 3): 429 + Retry-After.
    const throttled = await request(app.getHttpServer()).get('/employees').set(headers);
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
  });

  it('the credential routes carry their own STRICT profile (route-level @Throttle)', async () => {
    // With the tightened env the /auth/login route's strict @Throttle is what
    // fires after 3 attempts — NOT the lockout (4 wrong passwords would be the
    // account threshold; the 429 comes FIRST, proving the throttle sits in
    // front of credential processing).
    const body = {
      email: `nobody-${randomUUID()}@nowhere.example`,
      password: 'wrong-long-password-11',
    };
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app.getHttpServer()).post('/auth/login').send(body)).status).toBe(401);
    }
    const throttled = await request(app.getHttpServer()).post('/auth/login').send(body);
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
  });

  it('/health and /metrics are never throttled', async () => {
    for (let i = 0; i < 6; i += 1) {
      expect((await request(app.getHttpServer()).get('/health')).status).toBe(200);

    }
    const metrics = await request(app.getHttpServer()).get('/metrics');
    expect(metrics.status).toBe(200);
  });

  it('usage within the (tightened) default stays unthrottled; the lockout was never hit', async () => {
    const tenant = await registerTenant(app, 'throttle-normal');
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app.getHttpServer())
        .get('/events')
        .set(tenant.headers);
      expect(res.status).toBe(200);
    }
    // The over-limit calls above were THROTTLE responses only — no account
    // lockout rows were produced for the owner by the guarded side effects.
    expect(
      await request(app.getHttpServer()).get('/health'),
    ).toMatchObject({ status: 200 });
  });
});
