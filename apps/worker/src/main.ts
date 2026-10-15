import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// The consumer composition root comes from the business-logic package (design
// D4): this file is the worker's entrypoint, not business logic.
import { WorkerModule, logLevelsFor } from '@repo/core';

async function bootstrap() {
  const logger = new Logger('WorkerBootstrap');
  // Created buffered so the configured LOG_LEVEL (read once ConfigModule has
  // loaded `.env.<NODE_ENV>`) applies before anything is printed.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  app.useLogger(logLevelsFor(configService.get<string>('LOG_LEVEL')));

  app.enableShutdownHooks();

  logger.log('Worker process started — consuming the payroll-events queue...');
}

bootstrap();
