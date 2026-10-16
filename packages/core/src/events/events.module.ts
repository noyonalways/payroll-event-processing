import { Module } from '@nestjs/common';
import { PubSubModule } from '@repo/database';
import { EventsController } from './events.controller';
import { EventStreamController } from './event-stream.controller';
import { EventStreamService } from './event-stream.service';
import { EventsService } from './events.service';
import { EventRecoveryService } from './event-recovery.service';
import { PayloadValidator } from './payload.validator';
import { EventStatusPublisherModule } from './event-status-publisher.module';
import { PayrollEventQueueModule } from '../queue/payroll-event-queue.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';

@Module({
  imports: [PayrollEventQueueModule, IdempotencyModule, EventStatusPublisherModule, PubSubModule],
  // EventsController's `GET /events/:id` is a PARAMETRIC route: whichever
  // controller binds first wins the path `/events/stream`, so the static
  // `GET /events/stream` route must be registered BEFORE it (design D4).
  controllers: [EventStreamController, EventsController],
  providers: [EventsService, EventRecoveryService, PayloadValidator, EventStreamService],
})
export class EventsModule {}