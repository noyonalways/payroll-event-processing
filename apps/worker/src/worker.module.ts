import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { QueueModule } from '../../../src/queue/queue.module';
import { ProcessingModule } from '../../../src/processing/processing.module';
import { HeartbeatService } from '../../../src/processing/heartbeat.service';
import { PayrollEventProcessor } from './payroll-event.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        DATABASE_URL: Joi.string().required(),
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        LOG_LEVEL: Joi.string()
          .valid('log', 'error', 'warn', 'debug', 'verbose')
          .default('log'),
        PAYROLL_TEMPORARY_FAILURE_RATE: Joi.number().min(0).max(1).default(0.25),
        PAYROLL_PERMANENT_FAILURE_RATE: Joi.number().min(0).max(1).default(0.05),
        PAYROLL_FAILURE_MODE: Joi.string()
          .valid('random', 'always-success', 'always-transient', 'always-permanent')
          .default('random'),
        PAYROLL_MAX_RETRY_ATTEMPTS: Joi.number().integer().min(1).default(5),
        PAYROLL_RETRY_BASE_DELAY_MS: Joi.number().integer().min(0).default(1000),
        // BullMQ stalled-job recovery (design D3): lockDuration must exceed the
        // processing-tx timeout (10 s) so a healthy worker never false-stalls.
        PAYROLL_WORKER_LOCK_DURATION_MS: Joi.number().integer().min(1000).default(30000),
        PAYROLL_WORKER_STALLED_INTERVAL_MS: Joi.number().integer().min(1000).default(30000),
        PAYROLL_WORKER_MAX_STALLED_COUNT: Joi.number().integer().min(1).default(1),
        // Worker liveness heartbeat upsert cadence (design D4).
        WORKER_HEARTBEAT_INTERVAL_MS: Joi.number().integer().min(1000).default(5000),
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    PrismaModule,
    QueueModule,
    ProcessingModule,
  ],
  providers: [PayrollEventProcessor, HeartbeatService],
})
export class WorkerModule {}
