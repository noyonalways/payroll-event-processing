import { Module } from '@nestjs/common';
import { WebhookConfigService } from './webhook-config.service';
import { WebhookHttpClient } from './webhook-http.client';
import { WebhookOutboxWriter } from './webhook-outbox.writer';
import { WebhooksController } from './webhooks.controller';

/**
 * Webhook delivery (integrator-webhooks). Three cooperating pieces, split by
 * process so each app registers only what it runs:
 *
 * - `WebhookOutboxWriter` — the transactional outbox insert, used by BOTH
 *   terminal-commit sites (`EventClaim`, `EventRecoveryService.cancel`);
 *   exported here and imported wherever those services live.
 * - `WebhookConfigService` + `WebhooksController` — the HTTPS management and
 *   delivery-observability surface (this module is imported by `AppModule`).
 * - `WebhookRelayService` + `WebhookHttpClient` — the delivery driver,
 *   provided by the WORKER composition root only (single background-driver
 *   principle), never alongside the HTTP API process.
 */
@Module({
  controllers: [WebhooksController],
  providers: [WebhookConfigService, WebhookOutboxWriter, WebhookHttpClient],
  exports: [WebhookOutboxWriter, WebhookHttpClient],
})
export class WebhooksModule {}
