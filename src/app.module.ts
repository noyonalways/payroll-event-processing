import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './common/health/health.module';
import { EventsModule } from './events/events.module';

@Module({
  imports: [
    // Global config with env var validation — fails fast on missing required vars
    ConfigModule.forRoot({
      isGlobal: true,
      // `.env.development` / `.env.test` / `.env.production` hold host-local values.
      // docker compose injects its own topology overrides for api/worker and does
      // not rely on this file lookup (its env files are not copied into the image).
      envFilePath: `.env.${process.env.NODE_ENV ?? 'development'}`,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        PORT: Joi.number().default(3000),
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
    HealthModule,
    EventsModule,
  ],
})
export class AppModule {}
