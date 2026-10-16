import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventRecoveryService } from './event-recovery.service';
import { PayloadValidator } from './payload.validator';
import { PayrollEventQueueModule } from '../queue/payroll-event-queue.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';

@Module({
  imports: [PayrollEventQueueModule, IdempotencyModule],
  controllers: [EventsController],
  providers: [EventsService, EventRecoveryService, PayloadValidator],
})
export class EventsModule {}