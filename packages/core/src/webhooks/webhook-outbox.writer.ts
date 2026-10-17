import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WebhookTerminalStatus } from '@prisma/client';

/**
 * The payload snapshot the outbox row carries (design D4). Rendered ONCE at
 * intent-creation time — later result mutations never rewrite committed
 * notification history. `deliveryId` is stamped in per endpoint row after the
 * insert, so consumers can reference the delivery when deduplicating.
 */
export interface WebhookNotification {
  eventId: string;
  organizationId: string;
  employeeId: string;
  eventType: string;
  sequence: number;
  status: WebhookTerminalStatus;
  /** Handler result — set only on SUCCESS terminal commits. */
  result?: unknown;
  /** Failure reason — set only on FAILED terminal commits. */
  failedReason?: string;
  /** Terminal-commit time, recorded on the event row or captured at cancel. */
  occurredAt: string;
}

/**
 * Transactional outbox writer (integrator-webhooks design D3). Called with the
 * LIVE claim/recovery transaction client from BOTH terminal-commit sites —
 * `EventClaim` (success + permanent failure) and `EventRecoveryService.cancel`
 * — so the pending delivery intents commit atomically WITH the terminal
 * transition: all-or-nothing (reliability R5). The delivery itself happens
 * later, from the relay; a delivery failure can never touch this transaction.
 *
 * Endpoint selection reads ACTIVE rows INSIDE the same transaction, so an
 * endpoint registered a moment before a terminal commit cannot miss the
 * transition, and deactivating an endpoint stops new intents immediately.
 * Organizations with no active endpoints pay one indexed SELECT and nothing
 * else — the common case is a no-op.
 */
@Injectable()
export class WebhookOutboxWriter {
  private readonly logger = new Logger(WebhookOutboxWriter.name);

  async write(
    tx: Prisma.TransactionClient,
    notification: WebhookNotification,
  ): Promise<void> {
    const endpoints = await tx.webhookEndpoint.findMany({
      where: { organizationId: notification.organizationId, active: true },
      select: { id: true, url: true },
    });
    if (endpoints.length === 0) {
      return;
    }

    const occurredAt = new Date(notification.occurredAt);
    for (const endpoint of endpoints) {
      // Row-by-row so the intent's id can be stamped into its own payload
      // (createMany does not return the created rows). Endpoint counts are
      // small (human-managed config), so this is bounded work inside the tx.
      const delivery = await tx.webhookDelivery.create({
        data: {
          organizationId: notification.organizationId,
          webhookEndpointId: endpoint.id,
          eventId: notification.eventId,
          terminalStatus: notification.status,
          url: endpoint.url,
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: occurredAt,
          payload: Prisma.JsonNull,
        },
      });

      const payload = {
        eventId: notification.eventId,
        organizationId: notification.organizationId,
        employeeId: notification.employeeId,
        eventType: notification.eventType,
        sequence: notification.sequence,
        status: notification.status,
        result: notification.result ?? null,
        failedReason: notification.failedReason ?? null,
        occurredAt: notification.occurredAt,
        deliveryId: delivery.id,
      };
      await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: { payload: payload as unknown as Prisma.InputJsonValue },
      });
    }

    this.logger.log(
      `Webhook intents enqueued: ${endpoints.length} endpoint(s) for event ` +
        `${notification.eventId} (${notification.status}) in organization ` +
        `${notification.organizationId}`,
    );
  }
}

export { WebhookTerminalStatus };
