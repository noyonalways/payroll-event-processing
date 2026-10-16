import { Module } from '@nestjs/common';
import { PubSubModule } from '@repo/database';
import { EventStatusPublisher } from './event-status.publisher';

/**
 * Wires the cross-process transition publisher (design D2) on top of the
 * `@repo/database` Redis pub/sub connections. Imported by BOTH composition
 * paths — `EventsModule` (API-process publishes from the submission/recovery
 * services) and the worker's module graph (the processor publishes the
 * claim/terminal outcomes) — so every transition site injects this one
 * publisher.
 */
@Module({
  imports: [PubSubModule],
  providers: [EventStatusPublisher],
  exports: [EventStatusPublisher],
})
export class EventStatusPublisherModule {}
