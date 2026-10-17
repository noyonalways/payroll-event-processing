import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { AuthenticatedActor } from '../auth/authenticated-actor';
import { ApiRoles, Roles } from '../auth/decorators/roles.decorator';
import { MembershipRole } from '@prisma/client';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { WebhookConfigService } from './webhook-config.service';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
} from './dto/webhook-endpoint.dto';
import {
  WebhookEndpointCreatedDto,
  WebhookEndpointResponseDto,
} from './dto/webhook-endpoint-response.dto';
import { WebhookDeliveryResponseDto } from './dto/webhook-delivery-response.dto';

/**
 * Webhook endpoint configuration + delivery observability
 * (integrator-webhooks). All routes are tenant-scoped: the organization comes
 * from the verified access token via `@CurrentActor()`, never from the request.
 * Another organization's endpoint or delivery reads as 404, identical to an
 * unknown id.
 *
 * The signing secret appears in exactly ONE response — the 201 of
 * `POST /webhook-endpoints` — and in no read, ever.
 */
@ApiTags('webhooks')
@ApiBearerAuth()
@Controller()
export class WebhooksController {
  constructor(private readonly webhooksService: WebhookConfigService) {}

  /** POST /webhook-endpoints — register one HTTPS callback + signing secret. */
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Post('webhook-endpoints')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Register a webhook endpoint for the caller’s organization',
    description:
      'Creates an active endpoint with a generated HMAC-SHA256 signing secret. ' +
      'The secret is returned ONLY in this response and never again; duplicate ' +
      'labels inside the organization are rejected with 409. Delivery intents ' +
      'start flowing for every terminal event transition committed from now on.',
  })
  @ApiCreatedResponse({
    description: 'Endpoint registered; the one-time signing secret included',
    type: WebhookEndpointCreatedDto,
  })
  @ApiBadRequestResponse({
    description: 'Validation error: missing/blank label or a non-HTTPS URL',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'A webhook endpoint with the same label already exists in this organization',
    type: ErrorResponseDto,
  })
  async create(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointCreatedDto> {
    return this.webhooksService.createEndpoint(actor.organizationId, dto);
  }

  /** GET /webhook-endpoints — list the organization's endpoints (no secrets). */
  @Get('webhook-endpoints')
  @ApiOperation({
    summary: 'List the organization’s webhook endpoints',
    description: 'Returns every registered endpoint. Signing secrets are never included.',
  })
  @ApiOkResponse({
    description: 'The organization’s endpoints',
    type: WebhookEndpointResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async list(
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<WebhookEndpointResponseDto[]> {
    return this.webhooksService.listEndpoints(actor.organizationId);
  }

  /** PATCH /webhook-endpoints/:id — update label/URL/active flag. */
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Patch('webhook-endpoints/:id')
  @ApiOperation({
    summary: 'Update a webhook endpoint',
    description:
      'Updates the label, HTTPS URL, or active flag. Deactivating stops new ' +
      'delivery intents immediately; pending rows drain once reactivated. The ' +
      'signing secret is not patchable.',
  })
  @ApiParam({ name: 'id', description: 'Webhook endpoint id' })
  @ApiOkResponse({
    description: 'The updated endpoint (no signing secret)',
    type: WebhookEndpointResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown id, or an endpoint of another organization (indistinguishable)',
    type: ErrorResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Validation error in the patch body',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'A different endpoint already carries the requested label',
    type: ErrorResponseDto,
  })
  async update(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointResponseDto> {
    return this.webhooksService.updateEndpoint(actor.organizationId, id, dto);
  }

  /**
   * DELETE /webhook-endpoints/:id — remove the endpoint. Pending deliveries
   * are dead-lettered (`endpoint_removed`) in the same transaction; delivered
   * history stays queryable.
   */
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Delete('webhook-endpoints/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a webhook endpoint',
    description:
      'Removes the endpoint. Its pending deliveries are dead-lettered with reason ' +
      '`endpoint_removed`; committed delivery history is preserved.',
  })
  @ApiParam({ name: 'id', description: 'Webhook endpoint id' })
  @ApiNoContentResponse({ description: 'Endpoint deleted' })
  @ApiNotFoundResponse({
    description: 'Unknown id, or an endpoint of another organization (indistinguishable)',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async remove(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
  ): Promise<void> {
    await this.webhooksService.deleteEndpoint(actor.organizationId, id);
  }

  /** GET /webhook-deliveries/:id — one delivery with its attempt trail. */
  @Get('webhook-deliveries/:id')
  @ApiOperation({
    summary: 'Inspect one webhook delivery',
    description:
      'Returns the delivery state, the snapshotted notification payload, and the ' +
      'append-only POST attempt trail.',
  })
  @ApiParam({ name: 'id', description: 'Webhook delivery id' })
  @ApiOkResponse({ description: 'The delivery', type: WebhookDeliveryResponseDto })
  @ApiNotFoundResponse({
    description: 'Unknown id, or a delivery of another organization (indistinguishable)',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async getDelivery(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
  ): Promise<WebhookDeliveryResponseDto> {
    return this.webhooksService.getDelivery(actor.organizationId, id);
  }

  /** GET /webhook-endpoints/:id/deliveries — newest-first deliveries per endpoint. */
  @Get('webhook-endpoints/:id/deliveries')
  @ApiOperation({
    summary: 'List an endpoint’s deliveries',
    description:
      'Returns the endpoint’s deliveries newest-first with their attempt trails. ' +
      'Only deliveries of the caller’s organization are visible; an endpoint of ' +
      'another organization is a 404 exactly like an unknown id.',
  })
  @ApiParam({ name: 'id', description: 'Webhook endpoint id' })
  @ApiOkResponse({
    description: 'The endpoint’s deliveries, newest first',
    type: WebhookDeliveryResponseDto,
    isArray: true,
  })
  @ApiNotFoundResponse({
    description: 'Unknown endpoint id, or an endpoint of another organization (indistinguishable)',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async listDeliveries(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<WebhookDeliveryResponseDto[]> {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.webhooksService.listDeliveries(actor.organizationId, id, {
      ...(parsedLimit !== undefined && Number.isFinite(parsedLimit)
        ? { limit: parsedLimit }
        : {}),
      ...(cursor ? { cursor } : {}),
    });
  }
}
