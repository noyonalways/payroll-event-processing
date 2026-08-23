import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { PrismaModule } from '../../../src/prisma/prisma.module';

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
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    PrismaModule,
    // QueueModule will be imported in the bullmq-queue-integration change
  ],
})
export class WorkerModule {}
