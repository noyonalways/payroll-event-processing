import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const logger = new Logger('WorkerBootstrap');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  app.enableShutdownHooks();

  logger.log('Worker process started — waiting for jobs...');
  logger.log('Queue consumers will be registered in the bullmq-queue-integration change.');
}

bootstrap();
