import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Registers Swagger/OpenAPI documentation for the application.
 *
 * Always on — there is deliberately no environment toggle. Both the interactive
 * Swagger UI (`/api-docs`) and the machine-readable OpenAPI document
 * (`/api-docs-json`) are served in every NODE_ENV.
 */
export function setupSwagger(app: INestApplication, port: number): void {
  const config = new DocumentBuilder()
    .setTitle('Payroll Event Processing API')
    .setDescription(
      'Asynchronous multi-tenant payroll event processing service. Register an ' +
        'organization, then submit typed employee payroll events ' +
        '(BANK_ACCOUNT_CHANGE, ADDRESS_CHANGE, SALARY_CHANGE, DEPARTMENT_CHANGE) with a ' +
        'mandatory Idempotency-Key header; each submission is validated per type, ' +
        'deduplicated per organization, and persisted immediately while background ' +
        'processing happens asynchronously. Payroll endpoints require a bearer access ' +
        'token and only ever expose the caller’s organization.',
    )
    .setVersion('1.0.0')
    .setOpenAPIVersion('3.1.0')
    // The scheme NAME must match the one `@ApiBearerAuth()` puts on operations
    // (both default to 'bearer'). Without this registration the operations
    // reference a scheme that does not exist, and Swagger UI shows no way to
    // supply a token.
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access token from POST /auth/register or POST /auth/login. Send it as ' +
          '`Authorization: Bearer <accessToken>`.',
      },
      'bearer',
    )
    .addTag('auth', 'Authentication and tenant membership')
    .addTag('events', 'Payroll event submission and validation')
    .addTag('health', 'Service and dependency health')
    .addServer(`http://localhost:${port}`, 'Local')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('/api-docs', app, document, {
    jsonDocumentUrl: '/api-docs-json',
    customSiteTitle: 'Payroll Event Processing API',
    swaggerOptions: {
      docExpansion: 'list',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });
}