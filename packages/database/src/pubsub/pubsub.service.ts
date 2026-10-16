import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * The two dedicated Redis connections of the event-status-stream fan-out
 * (realtime-status design D1), colocated with the BullMQ queue's Redis usage
 * but sharing NO connection with it — BullMQ requires exclusive connections,
 * and a connection in subscriber mode cannot issue regular commands.
 *
 * - `publisher` — regular connection both processes use for fire-and-forget
 *   publishes. `lazyConnect` keeps process boot free of Redis state; the
 *   first command connects on demand.
 * - `subscriber` — subscriber-mode connection the API process attaches its
 *   channel subscriptions to. ioredis requires `maxRetriesPerRequest: null`
 *   in this mode (commands must not be rejected while reconnecting).
 *
 * Neither client is awaited during boot: a down Redis never blocks or fails
 * the processes (R2 isolation) — publishes and subscriptions simply begin
 * delivering once it returns.
 */
@Injectable()
export class PubSubService implements OnModuleDestroy {
  private readonly logger = new Logger(PubSubService.name);

  readonly publisher: Redis;
  readonly subscriber: Redis;

  constructor(config: ConfigService) {
    const host = config.get<string>('REDIS_HOST', 'localhost');
    const port = config.get<number>('REDIS_PORT', 6379);

    this.publisher = new Redis({ host, port, lazyConnect: true });
    this.subscriber = new Redis({
      host,
      port,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });

    // ioredis surfaces connection drops as 'error' events; without a listener
    // they crash an EventEmitter mid-connection. Degrade to a log line, the
    // same posture the processor's worker 'error' handler takes.
    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', (error: Error) => {
        this.logger.warn(`Pub/sub connection error: ${error.message}`);
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const client of [this.publisher, this.subscriber]) {
      try {
        await client.quit();
      } catch (error) {
        // quit() rejects when the connection was never established or already
        // dropped — the process is going down either way.
        this.logger.debug(
          `Pub/sub connection already down on shutdown: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.logger.log('Pub/sub connections closed');
  }
}
