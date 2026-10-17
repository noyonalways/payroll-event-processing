import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  HttpException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AUTH_THROTTLE } from '../auth/throttle.constants';
import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { AuthenticatedActor } from '../auth/authenticated-actor';
import { ApiRoles, Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { MembershipRole } from '@prisma/client';
import { MembersService, MembersServiceOpaqueInvitationError } from './members.service';
import { CreateInvitationDto, UpdateMemberRoleDto } from './dto/invitation.dto';
import { AcceptInvitationDto, AcceptInvitationResultDto } from './dto/accept-invitation.dto';
import {
  InvitationCreatedDto,
  InvitationResponseDto,
  MemberResponseDto,
} from './dto/member-response.dto';

/**
 * Membership management + invitations (org-membership-management). All
 * management routes are tenant-scoped from the verified token; gates follow
 * the access-control matrix: the member list is readable by every member,
 * invitations require ADMIN+, role changes and removal OWNER+, and token
 * acceptance is public (the token IS the credential, design D3).
 *
 * Every invalid-token acceptance path — unknown, expired, revoked, already
 * accepted, or a wrong existing-account password — returns the SAME opaque
 * 410, so the endpoint reveals neither invitation state nor account existence.
 */
@ApiTags('members')
@Controller()
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  // ── Members (authenticated) ────────────────────────────────────────────────

  /** GET /members — the organization's roster with roles (any member). */
  @ApiBearerAuth()
  @Get('members')
  @ApiOperation({
    summary: 'List the organization’s members',
    description:
      'Every member with identity, email, role, and joined-at. Readable by any member of the ' +
      'organization; another organization’s members never appear.',
  })
  @ApiOkResponse({ description: 'The organization’s members, oldest first', type: MemberResponseDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, or expired access token', type: ErrorResponseDto })
  async listMembers(@CurrentActor() actor: AuthenticatedActor): Promise<MemberResponseDto[]> {
    return this.membersService.listMembers(actor.organizationId);
  }

  /** PATCH /members/:userId/role — OWNER-gated role change. */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the OWNER role', type: ErrorResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error in the body', type: ErrorResponseDto })
  @ApiNotFoundResponse({ description: 'Unknown member, or a member of another organization (indistinguishable)', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'The last OWNER cannot be demoted, or the membership changed concurrently',
    type: ErrorResponseDto,
  })
  @Roles(MembershipRole.OWNER)
  @ApiRoles(MembershipRole.OWNER)
  @Patch('members/:userId/role')
  @ApiOperation({
    summary: 'Change a member’s role (OWNER only)',
    description:
      'Sets the membership role. The organization must keep at least one OWNER — demoting the ' +
      'last OWNER is a 409. Live sessions adopt the new role at their next refresh.',
  })
  @ApiParam({ name: 'userId' })
  @ApiOkResponse({ description: 'The updated membership', type: MemberResponseDto })
  async updateRole(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ): Promise<MemberResponseDto> {
    return this.membersService.updateMemberRole(actor.organizationId, userId, dto);
  }

  /** DELETE /members/:userId — OWNER-gated removal. */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the OWNER role', type: ErrorResponseDto })
  @ApiNotFoundResponse({ description: 'Unknown member, or a member of another organization (indistinguishable)', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'Removing yourself, the last OWNER, or a concurrent removal',
    type: ErrorResponseDto,
  })
  @Roles(MembershipRole.OWNER)
  @ApiRoles(MembershipRole.OWNER)
  @Delete('members/:userId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a member (OWNER only)',
    description:
      'Deletes the membership. Cannot target yourself or the last OWNER. The removed user’s ' +
      'next refresh fails — access ends within one refresh cycle.',
  })
  @ApiParam({ name: 'userId' })
  @ApiNoContentResponse({ description: 'Membership removed' })
  async removeMember(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.membersService.removeMember(actor.organizationId, actor.userId, userId);
  }

  // ── Invitations (ADMIN+) ───────────────────────────────────────────────────

  /** POST /invitations — create one pending invitation (returns the token once). */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error; OWNER-role invitations are rejected', type: ErrorResponseDto })
  @ApiConflictResponse({ description: 'A pending invitation for the email already exists', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Post('invitations')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Invite an email into the caller’s organization (ADMIN+)',
    description:
      'Creates a pending invitation with a single-use accept token. The token is returned ONLY ' +
      'here (and as the accept URL); share it out-of-band. Expires in ORG_INVITE_TTL_DAYS days.',
  })
  @ApiCreatedResponse({ description: 'Invitation + one-time accept token', type: InvitationCreatedDto })
  async createInvitation(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: CreateInvitationDto,
  ): Promise<InvitationCreatedDto> {
    return this.membersService.createInvitation(
      actor.organizationId,
      actor.userId,
      dto,
    );
  }

  /** GET /invitations — the organization's invitations (ADMIN+). */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Get('invitations')
  @ApiOperation({
    summary: 'List the organization’s invitations (ADMIN+)',
    description: 'Newest first. Accept tokens are never included.',
  })
  @ApiOkResponse({ description: 'The organization’s invitations', type: InvitationResponseDto, isArray: true })
  async listInvitations(@CurrentActor() actor: AuthenticatedActor): Promise<InvitationResponseDto[]> {
    return this.membersService.listInvitations(actor.organizationId);
  }

  /** DELETE /invitations/:id — revoke a PENDING invitation (ADMIN+). */
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @ApiNotFoundResponse({ description: 'Unknown invitation, or an invitation of another organization', type: ErrorResponseDto })
  @ApiConflictResponse({ description: 'The invitation is no longer pending', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Delete('invitations/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke a pending invitation (ADMIN+)',
    description: 'The token stops being acceptable immediately.',
  })
  @ApiParam({ name: 'id' })
  @ApiNoContentResponse({ description: 'Invitation revoked' })
  async revokeInvitation(@CurrentActor() actor: AuthenticatedActor, @Param('id') id: string): Promise<void> {
    await this.membersService.revokeInvitation(actor.organizationId, id);
  }

  // ── Acceptance (PUBLIC, token-gated) ───────────────────────────────────────

  /** POST /invitations/accept — public single-use join. */
  @Public()
  @Throttle({ strict: AUTH_THROTTLE })
  @Post('invitations/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation (public; the token is the credential)',
    description:
      'Creates the membership for the invited email: setting an initial password when the ' +
      'account is new, or verifying the existing account’s password. Every unusable token — ' +
      'unknown, expired, revoked, already accepted, or a wrong existing-account password — ' +
      'returns the same opaque 410. After acceptance, log in with the email + password and the ' +
      'returned organizationId.',
  })
  @ApiOkResponse({ description: 'Membership created; organization identity returned', type: AcceptInvitationResultDto })
  @ApiBadRequestResponse({ description: 'Validation error (token missing, weak password)', type: ErrorResponseDto })
  @ApiGoneResponse({
    description: 'Opaque: the token is unknown, expired, revoked, already accepted, or the existing account’s password was wrong',
  })
  async acceptInvitation(@Body() dto: AcceptInvitationDto): Promise<AcceptInvitationResultDto> {
    try {
      return await this.membersService.acceptInvitation(dto);
    } catch (error) {
      // EVERY unusable-token case collapses to the same opaque 410 — status
      // and body are identical for unknown/expired/revoked/accepted tokens and
      // for a wrong existing-account password, so nothing about invitation or
      // account state leaks.
      if (error instanceof MembersServiceOpaqueInvitationError) {
        throw new HttpException('Invitation is no longer valid', HttpStatus.GONE);
      }
      throw error;
    }
  }
}
