import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { setupSwagger } from '../src/common/swagger/setup-swagger';
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
      ]) {
        expect(doc.components.schemas).toHaveProperty(schema);
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
        ['/events/{id}', 'get'],
      ] as const) {
        const op = doc.paths[path][method];
        expect(op.security).toEqual([{ bearer: [] }]);
        expect(op.responses['401']).toBeDefined();
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