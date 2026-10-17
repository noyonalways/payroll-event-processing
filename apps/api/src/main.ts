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
  initTracing,
  initErrorTracking,
  MetricsService,
} from '@repo/core';

// Tracing FIRST (before module graph construction — observability design D3).
void initTracing();
// Sentry next: DSN-gated, fail-soft; the API5xx filter captures through it.
void initErrorTracking('api');

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // Created buffered so the configured LOG_LEVEL (read below, once ConfigModule
  // has loaded `.env.<NODE_ENV>`) applies before anything is printed.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  // Throttle keys derive from the REAL client behind reverse proxies
  // (auth-hardening design D3). Deployment topology is configuration.
  if (configService.get<boolean>('TRUST_PROXY')) {
    const expressApp = app.getHttpAdapter().getInstance() as {
      set: (setting: string, value: boolean) => void;
    };
    expressApp.set('trust proxy', true);
  }
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
  // The filter is the exception-path metrics recorder (observability design
  // D2) — it receives the process's registry.
  app.useGlobalFilters(new HttpExceptionFilter(app.get(MetricsService)));

  // CORS for local frontend dev
  app.enableCors();

  // Swagger/OpenAPI docs — served at /api-docs (UI) and /api-docs-json (JSON)
  setupSwagger(app, port);

  await app.listen(port);

  logger.log(`Application running on port ${port}`);
}

bootstrap();
