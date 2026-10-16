import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// The HTTP composition root and its collaborators come from the business-logic
// package (design D4): this file is the app's entrypoint, not business logic.
import {
  AppModule,
  HttpExceptionFilter,
  logLevelsFor,
  setupSwagger,
} from '@repo/core';

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

  // Graceful shutdown (realtime-status): on SIGTERM the event-status-stream's
  // onModuleDestroy closes every open SSE connection cleanly before exit.
  app.enableShutdownHooks();

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
