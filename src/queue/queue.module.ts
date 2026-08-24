import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PAYROLL_EVENTS_QUEUE } from './queue.constants';
import { PayrollEventQueueService } from './payroll-event-queue.service';

/**
 * Registers the BullMQ root config (Redis connection) and the `payroll-events`
 * queue. Consumed by BOTH Nest applications — the API (to enqueue on submit)
 * and the worker (to consume). Each process registers its own forRoot config
 * against the same Redis instance.
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
  providers: [PayrollEventQueueService],
  exports: [PayrollEventQueueService, BullModule],
})
export class QueueModule {}