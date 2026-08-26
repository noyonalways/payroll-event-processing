import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { logLevelsFor } from './common/logger/log-levels';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // Created buffered so the configured LOG_LEVEL (read below, once ConfigModule
  // has loaded `.env.<NODE_ENV>`) applies before anything is printed.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  app.useLogger(logLevelsFor(configService.get<string>('LOG_LEVEL')));
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
