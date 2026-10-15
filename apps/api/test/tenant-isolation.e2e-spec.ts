import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { registerTenant, TestTenant } from './support/auth';

/**
 * E2E for the tenant boundary itself — two organizations registered through the
 * real HTTP surface must never observe each other's payroll data, while each
 * keeps full use of its own namespace.
 *
 * The two client-chosen namespaces are the security-relevant ones and each has
 * its own test: the same Idempotency-Key value in two tenants must yield two
 * events with two stored responses (a global key would serve tenant A's response
 * body to tenant B), and the same employee number must not force two tenants
 * into one sequence space (a global per-employee counter would hand B a
 * sequence it never submitted).
 *
 * The API-only AppModule is booted (no WorkerModule): the assertions are about
 * the request/response boundary and the rows a submission writes, so a live
 * consumer would only add timing noise. Redis is up and the jobs are enqueued
 * normally; nothing drains them, which is fine — POST /events never depends on
 * the queue.
 */
jest.setTimeout(30_000);

describe('multi-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

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

    // Two independent organizations with two independent owner sessions.
    tenantA = await registerTenant(app, 'isolation-a');
    tenantB = await registerTenant(app, 'isolation-b');
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const key = () => randomUUID();
  const employee = (prefix: string) => `${prefix}-${randomUUID()}`;

  /** A payload whose address fields are free-form, so a tenant can own a sentinel. */
  const addressPayload = (employeeId: string, street = 'Main St') => ({
    eventType: 'ADDRESS_CHANGE',
    payload: {
      employeeId,
      effectiveDate: '2026-09-01',
      street,
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    },
  });

  const submitAs = (
    tenant: TestTenant,
    body: Record<string, unknown>,
    idempotencyKey: string = key(),
  ) =>
    http()
      .post('/events')
      .set(tenant.headers)
      .set('Idempotency-Key', idempotencyKey)
      .send(body)
      .expect(201);

  const readAs = (tenant: TestTenant, id: string) =>
    http().get(`/events/${id}`).set(tenant.headers);

  it('reads its own event but gets 404 for another tenant’s event, leaking none of its fields', async () => {
    const employeeId = employee('iso-a');
    const street = `sentinel-${randomUUID()}`;
    const id = (await submitAs(tenantA, addressPayload(employeeId, street))).body
      .id as string;

    // Tenant B asks for A's event id with B's OWN valid token: the row exists,
    // but not inside B's boundary — the read must fail closed.
    const foreign = await readAs(tenantB, id).expect(404);

    // The only trace of the event in the response is the id the CALLER supplied
    // in the URL — echoed by the structured error envelope like every other 404.
    // None of the event's own fields (employeeId, payload, status, sequence,
    // attempts, …) may appear: the body must not even hint at what lives behind
    // the boundary.
    const leaked = JSON.stringify(foreign.body);
    expect(leaked).not.toContain(employeeId);
    expect(leaked).not.toContain(street);
    for (const field of [
      'payload',
      'eventType',
      'employeeId',
      'sequence',
      'status',
      'result',
      'processedAt',
      'attempts',
    ]) {
      expect(foreign.body).not.toHaveProperty(field);
    }
    expect(foreign.body).toMatchObject({
      statusCode: 404,
      error: 'NotFoundException',
    });

    // The same call for B's OWN event succeeds as 200 — the 404 above is the
    // tenant boundary, not a broken read path.
    const ownEmployeeId = employee('iso-b');
    const ownId = (await submitAs(tenantB, addressPayload(ownEmployeeId))).body
      .id as string;
    const own = (await readAs(tenantB, ownId).expect(200)).body;

    expect(own.id).toBe(ownId);
    expect(own.employeeId).toBe(ownEmployeeId);
    expect(own.payload).toEqual(
      addressPayload(ownEmployeeId).payload,
    );
  });

  it('reports another tenant’s event exactly like a completely unknown id', async () => {
    const id = (await submitAs(tenantA, addressPayload(employee('iso-404'))))
      .body.id as string;
    const unknownId = randomUUID();

    const foreign = await readAs(tenantB, id).expect(404);
    const unknown = await readAs(tenantB, unknownId).expect(404);

    // Same status, same envelope keys, same exception name. Once the requested
    // id is substituted out, the two bodies are the same template — a caller
    // cannot distinguish "belongs to another organization" from "does not
    // exist", which is what makes the endpoint useless for probing other
    // tenants' ids.
    expect(foreign.status).toBe(unknown.status);
    expect(Object.keys(foreign.body).sort()).toEqual(
      Object.keys(unknown.body).sort(),
    );
    expect(foreign.body).toMatchObject({ statusCode: 404, error: 'NotFoundException' });
    expect(unknown.body).toMatchObject({ statusCode: 404, error: 'NotFoundException' });
    expect(foreign.body.message.replace(id, '<id>')).toBe(
      unknown.body.message.replace(unknownId, '<id>'),
    );
    expect(foreign.body.path.replace(id, '<id>')).toBe(
      unknown.body.path.replace(unknownId, '<id>'),
    );
    expect(Number.isNaN(Date.parse(foreign.body.timestamp))).toBe(false);
    expect(Number.isNaN(Date.parse(unknown.body.timestamp))).toBe(false);
  });

  it('lets both tenants submit with the same Idempotency-Key and serves each its own stored response', async () => {
    const shared = key();
    const employeeA = employee('iso-key-a');
    const employeeB = employee('iso-key-b');

    const firstA = await submitAs(tenantA, addressPayload(employeeA), shared);
    const firstB = await submitAs(tenantB, addressPayload(employeeB), shared);

    // One client-chosen key value, two distinct events: (organization, scope,
    // key) makes each tenant's dedupe space its own.
    expect(firstA.body.id).not.toBe(firstB.body.id);

    const replayA = await submitAs(tenantA, addressPayload(employeeA), shared);
    const replayB = await submitAs(tenantB, addressPayload(employeeB), shared);

    // Each tenant's replay returns exactly its own stored response — B is never
    // served A's event id (nor A, B's).
    expect(replayA.body).toEqual(firstA.body);
    expect(replayB.body).toEqual(firstB.body);
    expect(replayA.body.id).toBe(firstA.body.id);
    expect(replayB.body.id).toBe(firstB.body.id);

    // And each id resolves inside its own tenant only.
    await readAs(tenantA, firstA.body.id as string).expect(200);
    await readAs(tenantB, firstB.body.id as string).expect(200);
    await readAs(tenantB, firstA.body.id as string).expect(404);
    await readAs(tenantA, firstB.body.id as string).expect(404);
  });

  it('gives both tenants sequence 1 for the same employee number, with independent counters', async () => {
    const sharedEmployee = employee('iso-seq');

    const a1 = await submitAs(tenantA, addressPayload(sharedEmployee));
    const b1 = await submitAs(tenantB, addressPayload(sharedEmployee));

    const aBody1 = (await readAs(tenantA, a1.body.id as string).expect(200)).body;
    const bBody1 = (await readAs(tenantB, b1.body.id as string).expect(200)).body;

    // The employee number is tenant-local: both tenants legitimately start from
    // their own sequence 1 — nobody inherits the other tenant's counter.
    expect(aBody1.employeeId).toBe(sharedEmployee);
    expect(bBody1.employeeId).toBe(sharedEmployee);
    expect(aBody1.sequence).toBe(1);
    expect(bBody1.sequence).toBe(1);

    // A's next event advances A only; B's next event advances B only.
    const a2 = await submitAs(tenantA, addressPayload(sharedEmployee));
    const b2 = await submitAs(tenantB, addressPayload(sharedEmployee));

    const aBody2 = (await readAs(tenantA, a2.body.id as string).expect(200)).body;
    const bBody2 = (await readAs(tenantB, b2.body.id as string).expect(200)).body;

    expect(aBody2.sequence).toBe(2);
    expect(bBody2.sequence).toBe(2);
  });

  it('rejects requests with no token or a tampered token', async () => {
    const employeeId = employee('iso-auth');
    const id = (await submitAs(tenantA, addressPayload(employeeId))).body
      .id as string;

    // No Authorization header at all — the guard runs before tenancy, so even a
    // read of A's own event is 401, not 404.
    await http()
      .post('/events')
      .set('Idempotency-Key', key())
      .send(addressPayload(employeeId))
      .expect(401);
    await http().get(`/events/${id}`).expect(401);

    // A valid token after someone edited one character of it fails signature
    // verification the same way.
    await http()
      .post('/events')
      .set('Idempotency-Key', key())
      .set('Authorization', `Bearer ${tenantA.accessToken}tampered`)
      .send(addressPayload(employeeId))
      .expect(401);
    await http()
      .get(`/events/${id}`)
      .set('Authorization', `Bearer ${tenantA.accessToken}tampered`)
      .expect(401);
  });

  it('never returns the submitting tenant’s payload to another tenant', async () => {
    const employeeId = employee('iso-payload');
    const street = `secret-${randomUUID()}`;

    const id = (await submitAs(tenantA, addressPayload(employeeId, street))).body
      .id as string;

    // Positive control: A itself reads the payload back, sentinel and all, so a
    // later "not found" cannot pass merely because nothing was ever stored.
    const mine = (await readAs(tenantA, id).expect(200)).body;
    expect(mine.payload).toEqual(addressPayload(employeeId, street).payload);

    // B's read is a 404 whose body carries no part of A's payload.
    const foreign = await readAs(tenantB, id).expect(404);
    expect(JSON.stringify(foreign.body)).not.toContain(street);
    expect(JSON.stringify(foreign.body)).not.toContain(employeeId);
    expect(foreign.body.payload).toBeUndefined();
    expect(foreign.body.result).toBeUndefined();
  });
});
