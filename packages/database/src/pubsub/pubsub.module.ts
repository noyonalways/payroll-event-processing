import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PubSubService } from './pubsub.service';

/**
 * Registers the two event-status-stream Redis connections (design D1) —
 * consumed by BOTH Nest applications: the API (streams the notifications to
 * its SSE clients) and the worker (publishes transitions). `ConfigModule` is
 * imported so `ConfigService` resolves even where no global config has been
 * registered (the same belt-and-braces the `QueueModule` factory uses).
 */
@Module({
  imports: [ConfigModule],
  providers: [PubSubService],
  exports: [PubSubService],
})
export class PubSubModule {}
