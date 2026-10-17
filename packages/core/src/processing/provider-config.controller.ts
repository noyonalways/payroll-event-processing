import { Body, Controller, Delete, Get, HttpCode, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { AuthenticatedActor } from '../auth/authenticated-actor';
import { ApiRoles, Roles } from '../auth/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { UpsertProviderConfigDto } from './dto/provider-config.dto';
import {
  ProviderConfigCreatedDto,
  ProviderConfigResponseDto,
} from './dto/provider-config-response.dto';
import { ProviderConfigService } from './provider-config.service';

/**
 * Per-organization external payroll provider configuration
 * (real-provider-adapter, design D3): OWNER-gated create-or-replace, a
 * redacting read, and delete (back to the simulated provider). Replacing the
 * provider is an OWNER-level action — it changes WHO executes payroll for the
 * organization. The resolver re-reads this row per operation, so changes take
 * effect on the very next event without a restart.
 */
@ApiTags('provider-config')
@ApiBearerAuth()
@Controller('provider-config')
export class ProviderConfigController {
  constructor(private readonly providerConfigService: ProviderConfigService) {}

  /** PUT /provider-config — create or replace the configuration (returns credential once). */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the OWNER role', type: ErrorResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error: HTTP mode requires baseUrl and a credential; https (or loopback http) URL required',
    type: ErrorResponseDto,
  })
  @Roles(MembershipRole.OWNER)
  @ApiRoles(MembershipRole.OWNER)
  @Put()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Configure the external payroll provider (OWNER only)',
    description:
      'Create-or-replace the organization’s provider configuration. HTTP mode activates the ' +
      'external adapter for every subsequently processed event; SIMULATED (or deleting the row) ' +
      'resolves the default provider. The credential is returned ONLY in this response. The ' +
      'request/response contract for the external endpoint is documented in the /api-docs ' +
      'provider schema: POST JSON {eventId, organizationId, employeeId, eventType, sequence, ' +
      'payload, attempt} with `Authorization: Bearer <credential>`; respond 2xx ' +
      `{ "reference": "<non-empty>" }. 4xx rejections are permanent failures; network errors, ` +
      'timeouts and 5xx are transient and retried by the queue.',
  })
  @ApiOkResponse({ description: 'Configuration saved (credential included once)', type: ProviderConfigCreatedDto })
  async upsert(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: UpsertProviderConfigDto,
  ): Promise<ProviderConfigCreatedDto> {
    return this.providerConfigService.upsert(actor.organizationId, dto);
  }

  /** GET /provider-config — the configuration WITHOUT the credential. */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the OWNER role', type: ErrorResponseDto })
  @Roles(MembershipRole.OWNER)
  @ApiRoles(MembershipRole.OWNER)
  @Get()
  @ApiOperation({
    summary: 'Read the provider configuration (OWNER only; credential never returned)',
  })
  @ApiOkResponse({ description: 'The configuration (credential redacted)', type: ProviderConfigResponseDto })
  async read(@CurrentActor() actor: AuthenticatedActor): Promise<ProviderConfigResponseDto> {
    return this.providerConfigService.read(actor.organizationId);
  }

  /** DELETE /provider-config — back to the simulated provider. */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the OWNER role', type: ErrorResponseDto })
  @Roles(MembershipRole.OWNER)
  @ApiRoles(MembershipRole.OWNER)
  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete the provider configuration (OWNER only)',
    description: 'Subsequent events resolve the simulated provider again. Pending in-flight ' +
      'operations finish under the configuration resolved at their start.',
  })
  @ApiNoContentResponse({ description: 'Configuration deleted' })
  async remove(@CurrentActor() actor: AuthenticatedActor): Promise<void> {
    await this.providerConfigService.remove(actor.organizationId);
  }
}
