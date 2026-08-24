import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { PayloadValidator } from './payload.validator';

@Module({
  controllers: [EventsController],
  providers: [EventsService, PayloadValidator],
})
export class EventsModule {}