import { Injectable, Logger } from '@nestjs/common';
import { EVENT_STATUS_STREAM_CHANNEL, EventStatusNotification } from '@repo/shared';
import { PubSubService } from '@repo/database';

/**
 * Announces committed lifecycle transitions on the event-status-stream
 * (realtime-status design D2): one JSON `EventStatusNotification` published on
 * the shared Redis pub/sub topic for the API process's SSE subscribers.
 *
 * Fire-and-forget BY CONTRACT: `publish` returns immediately (the send is a
 * discarded promise), so a slow or down Redis can never delay a committing
 * transition — and because publication always happens strictly AFTER the
 * transition's transaction commits (the only call sites), a stream failure
 * can never reach, fail, or roll back the exactly-once terminal write (R2's
 * isolation discipline applied to the stream; R5's DB write stays the only
 * arbiter of outcome). A failed publish is logged with the structured
 * identity context and delivers nothing — the read endpoints are the
 * resynchronization path.
 */
@Injectable()
export class EventStatusPublisher {
  private readonly logger = new Logger(EventStatusPublisher.name);

  constructor(private readonly pubsub: PubSubService) {}

  publish(notification: EventStatusNotification): void {
    void this.send(notification);
  }

  private async send(notification: EventStatusNotification): Promise<void> {
    try {
      await this.pubsub.publisher.publish(
        EVENT_STATUS_STREAM_CHANNEL,
        JSON.stringify(notification),
      );
      this.logger.verbose(
        `Stream: published ${notification.status} for event ${notification.eventId} ` +
          `(${notification.eventType}, employee ${notification.employeeId}, organization ${notification.organizationId})`,
      );
    } catch (error) {
      this.logger.error(
        `Event-status stream publish failed for event ${notification.eventId} ` +
          `(${notification.eventType}, employee ${notification.employeeId}, ` +
          `organization ${notification.organizationId}) — nothing delivered, continuing: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
