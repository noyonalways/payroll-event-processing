import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PAYROLL_EVENTS_QUEUE } from '@repo/shared';

/**
 * Registers the BullMQ root config (Redis connection) and the `payroll-events`
 * queue. Consumed by BOTH Nest applications — the API (to enqueue on submit)
 * and the worker (to consume). Each process registers its own forRoot config
 * against the same Redis instance.
 *
 * This module is only the OUTBOUND connection (design D3): it re-exports
 * `BullModule`, which carries the registered queue token so `@InjectQueue`
 * resolves in importing modules. The producer (`PayrollEventQueueService`) and
 * the per-employee FIFO/relay semantics are business logic — they stay with the
 * application code in `@repo/core`, which provides them through its own
 * `PayrollEventQueueModule` instantiated on top of this registration.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    BullModule.registerQueue({ name: PAYROLL_EVENTS_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}