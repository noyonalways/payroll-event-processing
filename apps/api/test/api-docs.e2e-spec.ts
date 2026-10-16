import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule, HttpExceptionFilter, setupSwagger } from '@repo/core';
import { registerTenant } from './support/auth';

/**
 * E2E for the additive Swagger/OpenAPI surface — asserts the always-on
 * documentation endpoints that src/main.ts wires up. Writes no payroll rows;
 * Postgres is still booted because AppModule's PrismaService connects on module
 * init. One real tenant is registered through the HTTP surface first, so the
 * docs are served by the same tenant-aware module graph the payroll routes live
 * in (the docs endpoints themselves stay public and token-free).
 */
describe('Swagger/OpenAPI docs (e2e)', () => {
  let app: INestApplication;

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
    // Swagger is always on, in every environment — same call as main.ts.
    setupSwagger(app, 3000);
    await app.init();
    await registerTenant(app, 'api-docs');
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('GET /api-docs', () => {
    it('serves the Swagger UI HTML in every environment', async () => {
      const res = await http().get('/api-docs').expect(200);
      expect(res.text).toContain('swagger-ui');
    });
  });

  describe('GET /api-docs-json', () => {
    it('returns a valid OpenAPI 3.1 document', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;
      expect(doc.openapi).toMatch(/^3\.1/);
      expect(doc.info.title).toBe('Payroll Event Processing API');
    });

    it('documents both /events and /health paths', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;
      expect(doc.paths['/events']).toBeDefined();
      expect(doc.paths['/health']).toBeDefined();
    });

    it('declares all component schemas', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;
      for (const schema of [
        'CreateEventDto',
        'EventSubmissionResponseDto',
        'ErrorResponseDto',
        'HealthResponseDto',
        'EventType',
        'BankAccountChangePayloadDto',
        'AddressChangePayloadDto',
        'SalaryChangePayloadDto',
        'RegisterDto',
        'LoginDto',
        'RefreshTokenDto',
        'SessionResponseDto',
        'ActorIdentityDto',
        'EventActionResponseDto',
      ]) {
        expect(doc.components.schemas).toHaveProperty(schema);
      }
    });

    it('exposes the cancelled lifecycle state in the status vocabularies', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      // The shared lifecycle constant backs the status field of both the
      // single-event response and the list rows; CANCELLED (event-recovery)
      // must extend every one of them together.
      for (const schema of ['EventStatusResponseDto', 'EventListItemDto']) {
        const statuses = JSON.stringify(doc.components.schemas[schema]);
        expect(statuses).toContain('cancelled');
      }
    });

    it('documents GET /events/stream as bearer-secured with 401 (realtime-status)', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      const stream = doc.paths['/events/stream']?.get;
      expect(stream).toBeDefined();
      // Same header authentication as every other event endpoint.
      expect(stream.security).toEqual([{ bearer: [] }]);
      expect(stream.responses['401']).toBeDefined();
      // The 200 is the SSE frame stream (not a JSON media type) and its
      // documentation names the notification event kind.
      const ok = JSON.stringify(stream.responses['200']);
      expect(ok).toContain('text/event-stream');
      expect(ok).toContain('lifecycle');
      expect(ok).toContain('heartbeat');
    });

    it('documents both recovery operations as bearer-secured with 200/404/409/401', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      for (const path of ['/events/{id}/retry', '/events/{id}/cancel']) {
        const op = doc.paths[path]?.post;
        // One assert with the whole operation: a missing or misannotated
        // operation reads from the diff, which names the path for free.
        expect(op).toMatchObject({
          security: [{ bearer: [] }],
          responses: expect.objectContaining({
            '200': expect.objectContaining({
              content: { 'application/json': { schema: { '$ref': expect.stringContaining('EventActionResponseDto') } } },
            }),
            '401': expect.anything(),
            '404': expect.anything(),
            '409': expect.anything(),
          }),
        });
      }
    });

    it('marks the Idempotency-Key header as required on POST /events', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;
      const createOp = doc.paths['/events'].post;
      expect(createOp).toBeDefined();

      const header = createOp.parameters?.find(
        (p: { name: string }) => p.name === 'Idempotency-Key',
      );
      expect(header).toBeDefined();
      expect(header.in).toBe('header');
      expect(header.required).toBe(true);
    });
  });

  describe('authentication documentation', () => {
    it('declares the bearer security scheme the protected operations reference', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      // Without this registration the operations below point at a scheme that
      // does not exist, and Swagger UI offers no way to supply a token.
      const scheme = doc.components.securitySchemes?.bearer;
      expect(scheme).toBeDefined();
      expect(scheme.type).toBe('http');
      expect(scheme.scheme).toBe('bearer');
    });

    it('documents the five authentication operations', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      for (const [path, method] of [
        ['/auth/register', 'post'],
        ['/auth/login', 'post'],
        ['/auth/refresh', 'post'],
        ['/auth/logout', 'post'],
        ['/auth/me', 'get'],
      ] as const) {
        expect(doc.paths[path]?.[method]).toBeDefined();
      }

      // The credential-acquiring operations document their body and the session
      // they return; logout documents its 204.
      const register = doc.paths['/auth/register'].post;
      expect(register.requestBody).toBeDefined();
      expect(
        JSON.stringify(register.requestBody),
      ).toContain('RegisterDto');
      expect(register.responses['201']).toBeDefined();
      expect(doc.paths['/auth/login'].post.responses['401']).toBeDefined();
      expect(doc.paths['/auth/refresh'].post.responses['401']).toBeDefined();
      expect(doc.paths['/auth/logout'].post.responses['204']).toBeDefined();
    });

    it('documents the session response shape', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;
      const session = doc.components.schemas.SessionResponseDto;

      expect(Object.keys(session.properties)).toEqual(
        expect.arrayContaining([
          'accessToken',
          'refreshToken',
          'tokenType',
          'expiresIn',
          'refreshExpiresAt',
          'user',
          'organization',
          'role',
        ]),
      );
    });

    it('marks the payroll operations as bearer-secured with a documented 401', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      for (const [path, method] of [
        ['/events', 'post'],
        ['/events', 'get'],
        ['/events/{id}', 'get'],
      ] as const) {
        const op = doc.paths[path][method];
        expect(op.security).toEqual([{ bearer: [] }]);
        expect(op.responses['401']).toBeDefined();
      }
    });

    it('documents the employees directory endpoints (employee-directory)', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      // The five CRUD routes exist…
      for (const [path, method] of [
        ['/employees', 'post'],
        ['/employees', 'get'],
        ['/employees/{id}', 'get'],
        ['/employees/{id}', 'patch'],
        ['/employees/{id}', 'delete'],
      ] as const) {
        const op = doc.paths[path]?.[method];
        expect(op).toBeDefined();
        // …bearer-secured like every payroll operation, with a documented 401.
        expect(op.security).toEqual([{ bearer: [] }]);
        expect(op.responses['401']).toBeDefined();
      }

      // Create: typed 201 + the documented validation/conflict failures.
      const createOp = doc.paths['/employees'].post;
      expect(createOp.responses['201']).toBeDefined();
      expect(createOp.responses['400']).toBeDefined();
      expect(createOp.responses['409']).toBeDefined();

      // List: the DTO's deny-by-default query surface + typed page response.
      const list = doc.paths['/employees'].get;
      const paramNames = list.parameters.map((p: { name: string }) => p.name);
      for (const name of ['active', 'search', 'limit', 'cursor']) {
        expect(paramNames).toContain(name);
      }
      const limitParam = list.parameters.find((p: { name: string }) => p.name === 'limit');
      expect(limitParam.schema.minimum).toBe(1);
      expect(limitParam.schema.maximum).toBe(100);

      // Single-record routes: 404 documented; archive answers 204, not a body.
      for (const method of ['get', 'patch']) {
        expect(doc.paths['/employees/{id}'][method].responses['404']).toBeDefined();
        expect(doc.paths['/employees/{id}'][method].responses['200']).toBeDefined();
      }
      expect(doc.paths['/employees/{id}'].patch.responses['400']).toBeDefined();
      const del = doc.paths['/employees/{id}'].delete;
      expect(del.responses['204']).toBeDefined();
      expect(del.responses['404']).toBeDefined();

      // The employee representation is a documented component schema.
      expect(doc.components.schemas).toHaveProperty('EmployeeResponseDto');
      expect(doc.components.schemas).toHaveProperty('EmployeesListResponseDto');
    });

    it('documents GET /events with its query parameters and 400/401 responses', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      const list = doc.paths['/events'].get;
      expect(list).toBeDefined();

      // The listed query parameters are the DTO's deny-by-default surface.
      const paramNames = list.parameters.map((p: { name: string }) => p.name);
      for (const name of [
        'status',
        'eventType',
        'employeeId',
        'createdAfter',
        'createdBefore',
        'limit',
        'cursor',
      ]) {
        expect(paramNames).toContain(name);
      }
      // The documented filter enums match the wire vocabulary.
      const statusParam = list.parameters.find((p: { name: string }) => p.name === 'status');
      expect(statusParam.schema.enum).toEqual([
        'received',
        'queued',
        'processing',
        'success',
        'failed',
        'cancelled',
      ]);
      const limitParam = list.parameters.find((p: { name: string }) => p.name === 'limit');
      expect(limitParam.schema.minimum).toBe(1);
      expect(limitParam.schema.maximum).toBe(100);

      // Typed 200 page + the documented failures.
      expect(
        list.responses['200'].content['application/json'].schema['$ref'],
      ).toContain('EventListResponseDto');
      expect(
        list.responses['400'].content['application/json'].schema['$ref'],
      ).toContain('ErrorResponseDto');
      expect(
        list.responses['401'].content['application/json'].schema['$ref'],
      ).toContain('ErrorResponseDto');

      // The page schema: data rows + nextCursor + limit, and the row carries no
      // payload, result, or attempts (that is the single-event contract).
      const pageSchema = doc.components.schemas['EventListResponseDto'];
      expect(pageSchema).toBeDefined();
      expect(pageSchema.properties.data.type).toBe('array');
      expect(pageSchema.properties.data.items['$ref']).toContain('EventListItemDto');
      expect(pageSchema.properties.nextCursor).toBeDefined();
      expect(pageSchema.properties.nextCursor.nullable).toBe(true);
      expect(pageSchema.properties.limit).toBeDefined();

      const itemSchema = doc.components.schemas['EventListItemDto'];
      expect(itemSchema).toBeDefined();
      for (const key of [
        'id',
        'eventType',
        'employeeId',
        'sequence',
        'status',
        'createdAt',
        'updatedAt',
        'processedAt',
      ]) {
        expect(itemSchema.properties[key]).toBeDefined();
      }
      for (const absent of ['payload', 'result', 'attempts']) {
        expect(itemSchema.properties[absent]).toBeUndefined();
      }
    });

    it('leaves the public operations unauthenticated', async () => {
      const doc = (await http().get('/api-docs-json').expect(200)).body;

      // An orchestrator probes /health before any credential exists, and the
      // auth entry points are how a caller obtains one.
      expect(doc.paths['/health'].get.security).toBeUndefined();
      for (const path of ['/auth/register', '/auth/login', '/auth/refresh', '/auth/logout']) {
        expect(doc.paths[path].post.security).toBeUndefined();
      }
      // ...but /auth/me is the caller's own identity, so it IS protected.
      expect(doc.paths['/auth/me'].get.security).toEqual([{ bearer: [] }]);
    });
  });
});