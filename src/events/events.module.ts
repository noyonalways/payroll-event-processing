import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { PayloadValidator } from './payload.validator';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [QueueModule],
  controllers: [EventsController],
  providers: [EventsService, PayloadValidator],
})
export class EventsModule {}