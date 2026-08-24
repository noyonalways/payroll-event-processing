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
      'Asynchronous payroll event processing service. Submit typed employee ' +
        'payroll events (BANK_ACCOUNT_CHANGE, ADDRESS_CHANGE, SALARY_CHANGE) with a ' +
        'mandatory Idempotency-Key header; each submission is validated per type, ' +
        'deduplicated by key, and persisted immediately while background processing ' +
        'happens asynchronously.',
    )
    .setVersion('1.0.0')
    .setOpenAPIVersion('3.1.0')
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