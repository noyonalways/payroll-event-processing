import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { PayloadValidator } from './payload.validator';
import { QueueModule } from '../queue/queue.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';

@Module({
  imports: [QueueModule, IdempotencyModule],
  controllers: [EventsController],
  providers: [EventsService, PayloadValidator],
})
export class EventsModule {}