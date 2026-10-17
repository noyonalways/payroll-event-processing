import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { PrismaModule } from '@repo/database';
import { QueueModule } from '@repo/database';
import { resolveStageEnvFile } from '../config/env-file';
import { PayrollEventQueueModule } from '../queue/payroll-event-queue.module';
import { ProcessingModule } from '../processing/processing.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { WebhookRelayService } from '../webhooks/webhook-relay.service';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { WorkerMetricsService } from '../telemetry/worker-metrics.service';
import { AuthSweepService } from '../auth/auth-sweep.service';
import { AuthModule } from '../auth/auth.module';
import { HeartbeatService } from '../processing/heartbeat.service';
import { PayrollEventProcessor } from './payroll-event.processor';
import { EventStatusPublisherModule } from '../events/event-status-publisher.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Same stage file set as the API (apps/api/.env.<NODE_ENV>), resolved to
      // an absolute path (design D7, amended). The worker validates its own
      // narrower subset and needs no signing key, so only DATABASE_URL is
      // required when no file is present (the injected-environment container path).
      envFilePath: resolveStageEnvFile(['DATABASE_URL']),
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
        // Webhook delivery relay (integrator-webhooks design D6): poll cadence,
        // batch size, per-delivery retry cap, and request timeout. The relay
        // runs in the worker only — the single background-driver principle.
        // Real-provider HTTP adapter (real-provider-adapter design D4): the
        // per-request timeout bounding the external call INSIDE the claim tx.
        PROVIDER_HTTP_TIMEOUT_MS: Joi.number().integer().min(1000).default(10000),
        // Observability (design D1/D2): worker-side metrics surface + poll.
        METRICS_PROCESS_NAME: Joi.string().default('worker'),
        WORKER_METRICS_PORT: Joi.number().integer().min(1).default(9101),
        METRICS_QUEUE_POLL_MS: Joi.number().integer().min(1000).default(5000),
        // Auth retention sweep (auth-hardening design D4): interval + the
        // retention window for revoked/expired token rows.
        AUTH_SWEEP_INTERVAL_MS: Joi.number().integer().min(60_000).default(3_600_000),
        AUTH_TOKEN_RETENTION_DAYS: Joi.number().integer().min(1).default(7),
        WEBHOOK_RELAY_ENABLED: Joi.boolean().default(true),
        WEBHOOK_RELAY_INTERVAL_MS: Joi.number().integer().min(1000).default(5000),
        WEBHOOK_RELAY_BATCH_SIZE: Joi.number().integer().min(1).default(10),
        WEBHOOK_RELAY_MAX_ATTEMPTS: Joi.number().integer().min(1).default(8),
        WEBHOOK_DELIVERY_TIMEOUT_MS: Joi.number().integer().min(1000).default(10000),
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    PrismaModule,
    QueueModule,
    // The producer (PayrollEventQueueService) — pre-move it came with the
    // single QueueModule; task 3.4 split the connection into @repo/database
    // and the producer into this module, so the worker must import it again.
    PayrollEventQueueModule,
    ProcessingModule,
    // The worker's processor announces committed transitions on the
    // event-status-stream (realtime-status design D3).
    EventStatusPublisherModule,
    // Webhook delivery: the relay drives the transactional outbox produced by
    // the terminal commits (integrator-webhooks design D6). Imported module
    // provides the HTTP client; the controller/config surface is inert here.
    WebhooksModule,
    TelemetryModule,
    // The sweep needs nothing from the auth session machinery beyond Prisma +
    // config, but AuthModule carries its own Joi-validated ConfigModule —
    // harmless here, and the provider list stays deliberately explicit.
    AuthModule,
  ],
  providers: [
    PayrollEventProcessor,
    HeartbeatService,
    WebhookRelayService,
    WorkerMetricsService,
    AuthSweepService,
  ],
})
export class WorkerModule {}
