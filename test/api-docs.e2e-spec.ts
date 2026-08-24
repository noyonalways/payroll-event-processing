import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { setupSwagger } from '../src/common/swagger/setup-swagger';

/**
 * E2E for the additive Swagger/OpenAPI surface — asserts the always-on
 * documentation endpoints that src/main.ts wires up. Writes no rows; Postgres
 * is still booted because AppModule's PrismaService connects on module init.
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
});