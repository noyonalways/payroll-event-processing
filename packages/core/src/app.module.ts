import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AUTH_THROTTLE, DEFAULT_THROTTLE } from './auth/throttle.constants';
import { SkipThrottlerGuard } from './auth/skip-throttle.guard';
import { PrismaModule, QueueModule } from '@repo/database';
import { resolveStageEnvFile } from './config/env-file';
import { HealthModule } from './common/health/health.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { EmployeesModule } from './employees/employees.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { MembersModule } from './members/members.module';
import { ProviderConfigModule } from './processing/provider-config.module';
import { TelemetryModule } from './telemetry/telemetry.module';

@Module({
  imports: [
    // Global config with env var validation — fails fast on missing required vars
    ConfigModule.forRoot({
      isGlobal: true,
      // The stage file (`.env.<NODE_ENV>`) lives with the API app; it is
      // resolved to an absolute path so the lookup is working-directory
      // independent (design D7, amended). Docker compose does not rely on this
      // file: its env file + `environment:` overrides inject the values as
      // real environment variables, so a container without the file still starts.
      envFilePath: resolveStageEnvFile(['DATABASE_URL', 'AUTH_JWT_SECRET']),
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
        // Event-status-stream heartbeat cadence (realtime-status design D4):
        // the SSE comment-line liveness tick for open stream connections.
        EVENT_STREAM_HEARTBEAT_INTERVAL_MS: Joi.number().integer().min(1000).default(15000),
        // REQUIRED, and at least 32 chars: this key signs every access token, so
        // a guessable or absent secret would let anyone mint a token for any
        // organization. No default on purpose — the app must fail to boot rather
        // than start with a known key.
        AUTH_JWT_SECRET: Joi.string().min(32).required(),
        // Access tokens are short-lived because revocation is by expiry only.
        AUTH_ACCESS_TOKEN_TTL: Joi.string().default('15m'),
        // Refresh-token lifetime; refresh tokens are revoked rows, not JWTs.
        AUTH_REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).default(30),
        // Invitation validity window (org-membership-management design D1):
        // a pending invitation stops being acceptable after this many days.
        ORG_INVITE_TTL_DAYS: Joi.number().integer().min(1).default(7),
        // Observability (observability design D1): metrics surface naming.
        METRICS_PROCESS_NAME: Joi.string().default('api'),
        // Trust proxy topology so throttle keys derive from the real client
        // (auth-hardening design D3); app main applies it to Express.
        TRUST_PROXY: Joi.boolean().default(false),
        // Login lockout (auth-hardening design D1) + reset token lifetime.
        AUTH_LOCKOUT_THRESHOLD: Joi.number().integer().min(1).default(5),
        AUTH_LOCKOUT_MINUTES: Joi.number().integer().min(1).default(15),
        AUTH_RESET_TTL_MINUTES: Joi.number().integer().min(1).default(30),
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
    EmployeesModule,
    WebhooksModule,
    MembersModule,
    ProviderConfigModule,
    TelemetryModule,
    // Request throttling (auth-hardening design D3): generous default for
    // every route; concrete STRICT overrides are declared on the credential
    // routes themselves (auth controller + invitation acceptance). Health/metrics
    // routes skip via their own @SkipThrottle().
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: DEFAULT_THROTTLE.ttlMs,
        limit: DEFAULT_THROTTLE.limit,
      },
      {
        name: 'strict',
        ttl: AUTH_THROTTLE.ttlMs,
        limit: AUTH_THROTTLE.limit,
      },
    ]),
  ],
  // The ThrottlerGuard runs as the OUTERMOST app guard of the ROOT module —
  // it only ever sees requests that survived the auth machinery (design D3).
  providers: [{ provide: APP_GUARD, useClass: SkipThrottlerGuard }],

})
export class AppModule {}
