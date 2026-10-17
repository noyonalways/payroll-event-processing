import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '@repo/database';
import { MetricsService } from '../telemetry/metrics.service';
import { captureError } from '../telemetry/error-tracking';
import { WebhookHttpClient } from './webhook-http.client';
import {
  signWebhookBody,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from './webhook-signer';

/**
 * Delivery relay (integrator-webhooks design D6). One DB-scheduler tick
 * (`processDueOnce`) claims a bounded batch of due PENDING rows with
 * `SELECT … FOR UPDATE SKIP LOCKED` — multiple worker replicas claim disjoint
 * rows — delivers each while holding its row lock, and commits the outcome
 * (DELIVERED / backoff / DEAD_LETTERED + the append-only attempt row) in the
 * holding transaction. The interval is a setTimeout CHAIN, not setInterval:
 * a slow batch can never overlap itself.
 *
 * Classification (spec: transient vs permanent):
 * - 2xx within timeout → DELIVERED.
 * - 4xx → permanent → DEAD_LETTERED (`endpoint_rejected`).
 * - network error / timeout / 5xx / malformed successes → transient →
 *   attempts+1 with exponential backoff (base 30 s); reaching the cap
 *   dead-letters (`retries_exhausted`).
 *
 * At-least-once is accepted: a crash between a successful POST and the
 * acknowledgement commit redelivers — consumers deduplicate on the signed
 * body's eventId + status. Every attempt is audited in
 * `webhook_delivery_attempts`, never updated or deleted.
 */
@Injectable()
export class WebhookRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookRelayService.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private readonly backoffBaseMs = 30_000;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: WebhookHttpClient,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    const num = (key: string, fallback: number) =>
      (config.get<number>(key) ?? fallback) as number;
    this.intervalMs = num('WEBHOOK_RELAY_INTERVAL_MS', 5_000);
    this.batchSize = num('WEBHOOK_RELAY_BATCH_SIZE', 10);
    this.maxAttempts = num('WEBHOOK_RELAY_MAX_ATTEMPTS', 8);
    this.timeoutMs = num('WEBHOOK_DELIVERY_TIMEOUT_MS', 10_000);
    this.enabled = config.get<boolean>('WEBHOOK_RELAY_ENABLED') !== false;
  }

  /** Self-starts the poll chain when the providing app boots (unless disabled). */
  onModuleInit(): void {
    if (this.enabled) {
      this.start();
    } else {
      this.logger.log('Webhook relay disabled by WEBHOOK_RELAY_ENABLED=false');
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Starts the poll chain (worker composition root; no-op when disabled). */
  start(): void {
    if (this.timer || !this.intervalMs) {
      return;
    }
    this.scheduleNext(this.intervalMs);
    this.logger.log(
      `Webhook relay started (interval ${this.intervalMs}ms, batch ${this.batchSize}, ` +
        `max ${this.maxAttempts} attempts, timeout ${this.timeoutMs}ms)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // Never hold the process open just for the relay (mirrors other timers).
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.scheduleNext(this.intervalMs);
      return;
    }
    this.running = true;
    let delay = this.intervalMs;
    try {
      const processed = await this.processDueOnce();
      if (processed.length > 0) {
        this.logger.log(`Webhook relay processed ${processed.length} due delivery(ies)`);
      }
    } catch (error) {
      // Never let a tick kill the worker; backoff the schedule briefly.
      delay = Math.min(this.intervalMs, 1_000);
      this.logger.error(
        `Webhook relay tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
      this.scheduleNext(delay);
    }
  }

  /**
   * One bounded batch. Exposed as the unit of work so e2e tests drive
   * deliveries deterministically without timers.
   */
  async processDueOnce(): Promise<string[]> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        status: WebhookDeliveryStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: this.batchSize,
    });

    const processed: string[] = [];
    for (const { id } of due) {
      try {
        await this.deliverOne(id);
        processed.push(id);
      } catch (error) {
        // deliverOne commits its own outcome; a throw here means the claim
        // transaction itself failed (lock contention, DB outage). Skip and
        // retry next tick — the row stays PENDING and due.
        captureError(error, { deliveryId: id, kind: 'delivery-claim-failure' });
        this.logger.warn(
          `Delivery claim failed for ${id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return processed;
  }

  /** Claims one row with SKIP LOCKED and delivers it inside the claim tx. */
  private async deliverOne(deliveryId: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // 1. Claim: lock the pending row; a replica/other tick holding it is
        //    skipped, a non-PENDING row matches nothing.
        const claimed = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM webhook_deliveries
          WHERE id = ${deliveryId} AND status = 'PENDING'
          LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (claimed.length === 0) {
          return;
        }

        const delivery = await tx.webhookDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
          select: {
            id: true,
            url: true,
            payload: true,
            attempts: true,
            organizationId: true,
            eventId: true,
            endpoint: { select: { secret: true } },
          },
        });

        // 2. Secret resolution: the endpoint row is the ONLY source; its
        //    absence (deleted mid-flight) is undeliverable by nature.
        if (!delivery.endpoint) {
          await tx.webhookDelivery.update({
            where: { id: deliveryId },
            data: {
              status: WebhookDeliveryStatus.DEAD_LETTERED,
              deadLetterReason: 'endpoint_removed',
              nextAttemptAt: null,
            },
          });
          return;
        }

        // 3. Sign the EXACT bytes sent (design D4): serialize once, sign the
        //    serialized buffer, transmit that buffer.
        const rawBody = Buffer.from(
          JSON.stringify(delivery.payload as Record<string, unknown>),
          'utf8',
        );
        const signature = signWebhookBody(rawBody, delivery.endpoint.secret);
        const headers = {
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_DELIVERY_HEADER]: delivery.id,
          [WEBHOOK_EVENT_HEADER]: delivery.eventId,
          [WEBHOOK_TIMESTAMP_HEADER]: new Date().toISOString(),
        };

        const attemptNumber = delivery.attempts + 1;
        const result = await this.httpClient.post(
          delivery.url,
          headers,
          rawBody,
          this.timeoutMs,
        );

        // 4. Classification (design D6) + outcome commit inside the claim tx.
        if (result.ok && result.status !== null && result.status < 300) {
          await tx.webhookDelivery.update({
            where: { id: deliveryId },
            data: {
              status: WebhookDeliveryStatus.DELIVERED,
              attempts: attemptNumber,
              deliveredAt: new Date(),
              nextAttemptAt: null,
            },
          });
          await tx.webhookDeliveryAttempt.create({
            data: {
              deliveryId,
              attemptNumber,
              outcome: 'DELIVERED',
              responseStatus: result.status,
            },
          });
          this.metrics.recordWebhookDelivery('DELIVERED');
          this.logger.log(
            `Webhook delivery ${deliveryId} delivered (attempt ${attemptNumber}, ` +
              `status ${result.status}) to ${delivery.url}`,
          );
          return;
        }

        await tx.webhookDeliveryAttempt.create({
          data: {
            deliveryId,
            attemptNumber,
            outcome: 'FAILED',
            responseStatus: result.status,
            error: result.error ?? (result.bodyExcerpt ? `body: ${result.bodyExcerpt}` : null),
          },
        });

        const permanent = result.status !== null && result.status < 500;
        if (permanent) {
          await tx.webhookDelivery.update({
            where: { id: deliveryId },
            data: {
              status: WebhookDeliveryStatus.DEAD_LETTERED,
              attempts: attemptNumber,
              deadLetterReason: 'endpoint_rejected',
              nextAttemptAt: null,
            },
          });
          this.metrics.recordWebhookDelivery('DEAD_LETTERED');
          this.logger.warn(
            `Webhook delivery ${deliveryId} dead-lettered: endpoint rejected with ` +
              `${result.status} (attempt ${attemptNumber})`,
          );
          return;
        }

        const exhausted = attemptNumber >= this.maxAttempts;
        if (exhausted) {
          await tx.webhookDelivery.update({
            where: { id: deliveryId },
            data: {
              status: WebhookDeliveryStatus.DEAD_LETTERED,
              attempts: attemptNumber,
              deadLetterReason: 'retries_exhausted',
              nextAttemptAt: null,
            },
          });
          this.metrics.recordWebhookDelivery('DEAD_LETTERED');
          this.logger.warn(
            `Webhook delivery ${deliveryId} dead-lettered: retries exhausted after ` +
              `${attemptNumber} attempts (${result.error ?? `status ${result.status}`})`,
          );
          return;
        }

        // Transient: exponential backoff — base * 2^(attempt-1). The row stays
        // PENDING and drops out of the due set until next_attempt_at.
        const backoffMs = this.backoffBaseMs * Math.pow(2, attemptNumber - 1);
        await tx.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            attempts: attemptNumber,
            nextAttemptAt: new Date(Date.now() + backoffMs),
          },
        });
        this.logger.warn(
          `Webhook delivery ${deliveryId} transient failure (attempt ${attemptNumber}, ` +
            `${result.error ?? `status ${result.status}`}) — retry in ${backoffMs}ms`,
        );
      },
      { timeout: this.timeoutMs + 30_000, maxWait: 5_000 },
    );
  }
}
