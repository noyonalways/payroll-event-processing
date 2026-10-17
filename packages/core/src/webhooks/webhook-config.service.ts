import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, WebhookDeliveryStatus, WebhookTerminalStatus } from '@prisma/client';
import { PrismaService } from '@repo/database';
import { generateWebhookSecret } from './webhook-signer';
import {
  WebhookDeliveryResponseDto,
  WebhookDeliveryAttemptDto,
} from './dto/webhook-delivery-response.dto';
import { WebhookEndpointResponseDto } from './dto/webhook-endpoint-response.dto';
import { CreateWebhookEndpointDto } from './dto/webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/webhook-endpoint.dto';

/**
 * Per-organization webhook endpoint configuration (integrator-webhooks design
 * D5). The tenant boundary is the first argument of every public method — the
 * same convention as `EventsService` — and comes from the verified access
 * token. Another organization's endpoint reads as 404, identical to unknown.
 *
 * The signing secret is stored recoverable (every future delivery must be
 * signed with it) but leaves the service exactly once: in the create response.
 * Every read maps it out before returning.
 *
 * DELETE follows design D5: pending deliveries of the endpoint are
 * dead-lettered FIRST, in the same transaction as the row delete, so nothing
 * dangles — the relay never needs a secret that no longer exists. Committed
 * delivery history survives via the rows' denormalized `url` (the endpoint FK
 * is SetNull).
 */
@Injectable()
export class WebhookConfigService {
  private readonly logger = new Logger(WebhookConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createEndpoint(
    organizationId: string,
    dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointResponseDto & { signingSecret: string }> {
    const secret = generateWebhookSecret();
    try {
      const row = await this.prisma.webhookEndpoint.create({
        data: {
          organizationId,
          label: dto.label,
          url: dto.url,
          secret,
          active: true,
        },
      });
      this.logger.log(
        `Webhook endpoint ${row.id} (${row.label}) registered for organization ${organizationId}`,
      );
      // The ONLY place the secret is returned at full value.
      return { ...this.toResponse(row), signingSecret: secret };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          `A webhook endpoint labeled '${dto.label}' already exists in this organization`,
        );
      }
      throw error;
    }
  }

  async listEndpoints(organizationId: string): Promise<WebhookEndpointResponseDto[]> {
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async updateEndpoint(
    organizationId: string,
    id: string,
    dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointResponseDto> {
    const row = await this.prisma.webhookEndpoint.findFirst({
      where: { id, organizationId },
    });
    if (!row) {
      throw new NotFoundException(`Webhook endpoint with id ${id} not found`);
    }
    try {
      const updated = await this.prisma.webhookEndpoint.update({
        where: { id },
        data: {
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.url !== undefined ? { url: dto.url } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
      this.logger.log(
        `Webhook endpoint ${id} (${updated.label}) updated in organization ${organizationId} ` +
          `(active=${updated.active})`,
      );
      return this.toResponse(updated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          `A webhook endpoint labeled '${dto.label}' already exists in this organization`,
        );
      }
      throw error;
    }
  }

  async deleteEndpoint(organizationId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.webhookEndpoint.findFirst({
        where: { id, organizationId },
        select: { id: true },
      });
      if (!row) {
        throw new NotFoundException(`Webhook endpoint with id ${id} not found`);
      }
      // Pending deliveries can never be delivered again — their signing secret
      // is going away. Dead-letter them in the SAME transaction so no in-flight
      // intent outlives the endpoint that must serve it (design D5).
      const { count } = await tx.webhookDelivery.updateMany({
        where: {
          webhookEndpointId: id,
          organizationId,
          status: WebhookDeliveryStatus.PENDING,
        },
        data: {
          status: WebhookDeliveryStatus.DEAD_LETTERED,
          deadLetterReason: 'endpoint_removed',
          nextAttemptAt: null,
        },
      });
      await tx.webhookEndpoint.delete({ where: { id } });
      this.logger.log(
        `Webhook endpoint ${id} deleted from organization ${organizationId} — ` +
          `${count} pending delivery(ies) dead-lettered`,
      );
    });
  }

  /**
   * Deliveries read API (spec: "Delivery status is observable"). The endpoint
   * itself is tenant-checked first — another organization's endpoint reads as
   * 404, identical to an unknown id — then its deliveries listed newest-first
   * with the append-only attempt trail included.
   */
  async listDeliveries(
    organizationId: string,
    endpointId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<WebhookDeliveryResponseDto[]> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, organizationId },
      select: { id: true },
    });
    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint with id ${endpointId} not found`);
    }
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { organizationId, webhookEndpointId: endpointId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(options.limit ?? 50, 200),
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: { deliveryAttempts: { orderBy: { attemptNumber: 'asc' } } },
    });
    return rows.map((row) => this.toDeliveryResponse(row));
  }

  async getDelivery(
    organizationId: string,
    id: string,
  ): Promise<WebhookDeliveryResponseDto> {
    const row = await this.prisma.webhookDelivery.findFirst({
      where: { id, organizationId },
      include: { deliveryAttempts: { orderBy: { attemptNumber: 'asc' } } },
    });
    if (!row) {
      throw new NotFoundException(`Webhook delivery with id ${id} not found`);
    }
    return this.toDeliveryResponse(row);
  }

  private toResponse(row: {
    id: string;
    label: string;
    url: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): WebhookEndpointResponseDto {
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDeliveryResponse(
    row: Prisma.WebhookDeliveryGetPayload<{ include: { deliveryAttempts: true } }>,
  ): WebhookDeliveryResponseDto {
    const trail: WebhookDeliveryAttemptDto[] = row.deliveryAttempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      responseStatus: attempt.responseStatus,
      error: attempt.error,
      createdAt: attempt.createdAt.toISOString(),
    }));
    const payload = row.payload as Prisma.JsonObject;
    return {
      id: row.id,
      webhookEndpointId: row.webhookEndpointId,
      url: row.url,
      eventId: row.eventId,
      terminalStatus: row.terminalStatus as WebhookTerminalStatus,
      payload: payload as unknown as Record<string, unknown>,
      status: row.status as WebhookDeliveryStatus,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      deadLetterReason: row.deadLetterReason,
      createdAt: row.createdAt.toISOString(),
      attemptTrail: trail,
    };
  }
}
