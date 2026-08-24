import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { QueueModule } from '../../../src/queue/queue.module';
import { ProcessingModule } from '../../../src/processing/processing.module';
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
  providers: [PayrollEventProcessor],
})
export class WorkerModule {}
