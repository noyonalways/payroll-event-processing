import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';

/**
 * Shared authenticated-request support for the e2e suites.
 *
 * Every payroll endpoint is tenant-scoped and requires an access token, so a
 * suite that wants to submit or read an event must first own an organization.
 * `registerTenant` does that through the real HTTP surface (`POST /auth/register`
 * creates the organization and its OWNER and returns a session), which keeps the
 * tests honest: they exercise the same path a client would, and a change that
 * breaks registration breaks every suite loudly instead of being papered over by
 * a seeded row.
 *
 * Identifiers are unique per call so suites can run in any order and repeatedly
 * against the same database without colliding — including two tenants that
 * deliberately share an employee number or an idempotency key.
 */

/** Shared across every generated tenant; long enough for the register DTO. */
export const TEST_PASSWORD = 'correct-horse-battery';

export interface TestTenant {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  /** Ready to spread into a supertest chain: `.set(tenant.headers)`. */
  headers: { Authorization: string };
}

let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}-${randomUUID().slice(0, 8)}`;
}

/**
 * Registers a brand-new organization and returns its session. Every call yields
 * a distinct tenant, which is what makes cross-tenant assertions meaningful.
 */
export async function registerTenant(
  app: INestApplication,
  label = 'tenant',
): Promise<TestTenant> {
  const email = `${unique(label)}@e2e.example`;
  const organizationName = `E2E ${unique(label)}`;

  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      email,
      password: TEST_PASSWORD,
      name: `${label} owner`,
      organizationName,
    })
    .expect(201);

  return {
    organizationId: res.body.organization.id,
    organizationSlug: res.body.organization.slug,
    organizationName,
    userId: res.body.user.id,
    email,
    password: TEST_PASSWORD,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    headers: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

/**
 * Signs the same account in again, yielding an independent session for the same
 * organization — for tests that need two concurrent tokens (refresh rotation,
 * session replacement) without creating a second tenant.
 */
export async function loginTenant(
  app: INestApplication,
  tenant: TestTenant,
): Promise<TestTenant> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: tenant.email, password: tenant.password })
    .expect(200);

  return {
    ...tenant,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    headers: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

/**
 * An authenticated supertest agent for a tenant: `agent.post('/events')` already
 * carries the bearer token, so a suite's request chain reads like the HTTP call
 * it makes. `supertest.agent` binds to the server, so this is cheap to call per
 * request.
 */
export function authAgent(app: INestApplication, tenant: TestTenant) {
  return {
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set(tenant.headers),
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set(tenant.headers),
    delete: (url: string) =>
      request(app.getHttpServer()).delete(url).set(tenant.headers),
  };
}
