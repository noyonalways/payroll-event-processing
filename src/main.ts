import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  // Global validation pipe — whitelist strips unknown fields, forbidNonWhitelisted rejects them
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter — structured JSON error responses
  app.useGlobalFilters(new HttpExceptionFilter());

  // CORS for local frontend dev
  app.enableCors();

  // Swagger/OpenAPI docs — served at /api-docs (UI) and /api-docs-json (JSON)
  setupSwagger(app, port);

  await app.listen(port);

  logger.log(`Application running on port ${port}`);
}

bootstrap();
