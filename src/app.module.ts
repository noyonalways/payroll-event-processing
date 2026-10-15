import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './common/health/health.module';
import { AuthModule } from './auth/auth.module';
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
        PAYROLL_MAX_RETRY_ATTEMPTS: Joi.number().integer().min(1).default(5),
        PAYROLL_RETRY_BASE_DELAY_MS: Joi.number().integer().min(0).default(1000),
        IDEMPOTENCY_TTL_SECONDS: Joi.number().integer().min(1).default(86400),
        IDEMPOTENCY_SWEEP_INTERVAL_MS: Joi.number().integer().min(1000).default(60000),
        // Worker-liveness staleness threshold for /health (design D4): a worker
        // whose last_seen_at is older than this (ms) is reported stale/degraded.
        HEALTH_WORKER_STALE_MS: Joi.number().integer().min(1000).default(15000),
        // REQUIRED, and at least 32 chars: this key signs every access token, so
        // a guessable or absent secret would let anyone mint a token for any
        // organization. No default on purpose — the app must fail to boot rather
        // than start with a known key.
        AUTH_JWT_SECRET: Joi.string().min(32).required(),
        // Access tokens are short-lived because revocation is by expiry only.
        AUTH_ACCESS_TOKEN_TTL: Joi.string().default('15m'),
        // Refresh-token lifetime; refresh tokens are revoked rows, not JWTs.
        AUTH_REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).default(30),
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    PrismaModule,
    QueueModule,
    HealthModule,
    AuthModule,
    EventsModule,
  ],
})
export class AppModule {}
