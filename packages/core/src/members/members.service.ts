import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { MembershipRole, OrgInvitationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@repo/database';
import { PasswordService } from '../auth/password.service';
import { CreateInvitationDto } from './dto/invitation.dto';
import { UpdateMemberRoleDto } from './dto/invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import {
  InvitationCreatedDto,
  InvitationResponseDto,
  MemberResponseDto,
} from './dto/member-response.dto';

/**
 * Organization membership lifecycle (org-membership-management design D2–D5).
 * The tenant boundary is the first argument of every tenant-scoped method —
 * the same convention as `EventsService` — taken from the verified token, and
 * another organization's rows read as 404 exactly like unknown ids.
 *
 * Consistency-critical writes run guarded transactions (the codebase's
 * established pattern): role changes and removals re-check the last-owner
 * invariant INSIDE the transaction, and acceptance claims the invitation with
 * a guarded `PENDING → ACCEPTED` transition so a token can never redeem twice
 * — the loser of a race matches 0 rows and aborts without creating anything.
 *
 * Enforcement reach: role changes and removals take effect for live sessions
 * through the existing refresh path (`auth.service.refresh` re-reads the
 * membership), bounded by the short access-token TTL — no new revocation
 * channel (design D5).
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);
  private readonly inviteTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    config: ConfigService,
  ) {
    const days = config.get<number>('ORG_INVITE_TTL_DAYS') ?? 7;
    this.inviteTtlMs = days * 24 * 60 * 60 * 1000;
  }

  // ── Members ────────────────────────────────────────────────────────────────

  async listMembers(organizationId: string): Promise<MemberResponseDto[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true, name: true } } },
    });
    return memberships.map((membership) => ({
      userId: membership.userId,
      email: membership.user.email,
      name: membership.user.name,
      role: membership.role,
      joinedAt: membership.createdAt.toISOString(),
    }));
  }

  /**
   * OWNER-gated role change (design D4): a guarded transaction that re-checks
   * the last-owner invariant after the update — if the org would end up with
   * zero OWNer rows, the whole transaction rolls back with `409`.
   */
  async updateMemberRole(
    organizationId: string,
    targetUserId: string,
    dto: UpdateMemberRoleDto,
  ): Promise<MemberResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.membership.findFirst({
        where: { organizationId, userId: targetUserId },
        include: { user: { select: { email: true, name: true } } },
      });
      if (!target) {
        throw new NotFoundException(`Member ${targetUserId} not found`);
      }

      const { count } = await tx.membership.updateMany({
        where: { organizationId, userId: targetUserId },
        data: { role: dto.role },
      });
      if (count === 0) {
        throw new ConflictException('Membership changed concurrently');
      }

      // Last-owner invariant, evaluated INSIDE the tx: demoting or removing
      // the org's only OWNER must be impossible, whoever else is acting.
      if (target.role === MembershipRole.OWNER && dto.role !== MembershipRole.OWNER) {
        const owners = await tx.membership.count({
          where: { organizationId, role: MembershipRole.OWNER },
        });
        if (owners === 0) {
          throw new ConflictException(
            'Cannot demote the last owner — the organization must keep at least one OWNER',
          );
        }
      }

      this.logger.log(
        `Role changed to ${dto.role} for user ${targetUserId} in organization ${organizationId}`,
      );
      return {
        userId: target.userId,
        email: target.user.email,
        name: target.user.name,
        role: dto.role,
        joinedAt: target.createdAt.toISOString(),
      };
    });
  }

  /**
   * OWNER-gated removal (design D4): the target must exist in the org (404
   * otherwise, foreign orgs included), removing ONESELF is a `409`, and the
   * last-owner invariant again holds inside the transaction. After commit the
   * removed user's next refresh fails (existing refresh-time enforcement).
   */
  async removeMember(
    organizationId: string,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    if (actorId === targetUserId) {
      throw new ConflictException('You cannot remove your own membership through this API');
    }
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.membership.findFirst({
        where: { organizationId, userId: targetUserId },
      });
      if (!target) {
        throw new NotFoundException(`Member ${targetUserId} not found`);
      }
      if (target.role === MembershipRole.OWNER) {
        const owners = await tx.membership.count({
          where: { organizationId, role: MembershipRole.OWNER },
        });
        if (owners <= 1) {
          throw new ConflictException(
            'Cannot remove the last owner — the organization must keep at least one OWNER',
          );
        }
      }
      const { count } = await tx.membership.deleteMany({
        where: { organizationId, userId: targetUserId },
      });
      if (count === 0) {
        throw new ConflictException('Membership removed concurrently');
      }
      this.logger.log(
        `Member ${targetUserId} removed from organization ${organizationId} by ${actorId}`,
      );
    });
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  async createInvitation(
    organizationId: string,
    invitedBy: string,
    dto: CreateInvitationDto,
  ): Promise<InvitationCreatedDto> {
    const email = dto.email.trim().toLowerCase();

    // One PENDING invitation per (organization, email) — checked upfront and
    // enforced at the store by the PARTIAL unique index in the migration, so a
    // concurrent duplicate create loses with P2002 (mapped to the same 409).
    const pending = await this.prisma.orgInvitation.findFirst({
      where: { organizationId, email, status: OrgInvitationStatus.PENDING },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException(
        `A pending invitation for ${email} already exists in this organization`,
      );
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.inviteTtlMs);

    try {
      const row = await this.prisma.orgInvitation.create({
        data: {
          organizationId,
          email,
          role: dto.role,
          tokenHash,
          invitedBy,
          expiresAt,
        },
      });
      this.logger.log(
        `Invitation ${row.id} created for ${email} (${dto.role}) in organization ${organizationId}`,
      );
      return {
        ...this.toInvitationResponse(row),
        acceptToken: rawToken,
        acceptUrl: `/invite/${rawToken}`,
      };
    } catch (error) {
      // A concurrent create of the same pending (org, email) pair lost the
      // race with the partial unique index — same 409 as the pre-check.
      throw this.mapInvitationConflict(error, email);
    }
  }

  async listInvitations(organizationId: string): Promise<InvitationResponseDto[]> {
    const rows = await this.prisma.orgInvitation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toInvitationResponse(row));
  }

  /** Revocation is a guarded transition: only PENDING can be revoked (409s otherwise). */
  async revokeInvitation(organizationId: string, id: string): Promise<void> {
    const row = await this.prisma.orgInvitation.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    });
    if (!row) {
      throw new NotFoundException(`Invitation ${id} not found`);
    }
    const { count } = await this.prisma.orgInvitation.updateMany({
      where: { id, organizationId, status: OrgInvitationStatus.PENDING },
      data: { status: OrgInvitationStatus.REVOKED },
    });
    if (count === 0) {
      throw new ConflictException(`Invitation ${id} is no longer pending`);
    }
    this.logger.log(`Invitation ${id} revoked in organization ${organizationId}`);
  }

  /**
   * PUBLIC token-gated acceptance (design D3): hash-lookup, guarded
   * `PENDING → ACCEPTED` claim, account creation/verification, membership
   * creation — all in one transaction. EVERY invalid case (unknown, expired,
   * revoked, accepted, wrong existing-account password) collapses to the same
   * opaque `410` so the response never reveals invitation state or account
   * existence.
   */
  async acceptInvitation(dto: AcceptInvitationDto): Promise<{
    organizationId: string;
    organizationName: string;
    role: string;
    email: string;
  }> {
    const tokenHash = this.hashToken(dto.token.trim());

    const claimed = await this.prisma.$transaction(async (tx) => {
      const invitation = await tx.orgInvitation.findUnique({
        where: { tokenHash },
      });
      const valid =
        invitation !== null &&
        invitation.status === OrgInvitationStatus.PENDING &&
        invitation.expiresAt > new Date();
      if (!valid) {
        throw new MembersServiceOpaqueInvitationError();
      }

      // Guarded claim: only one concurrent acceptance can flip the row.
      const { count } = await tx.orgInvitation.updateMany({
        where: {
          id: invitation.id,
          status: OrgInvitationStatus.PENDING,
          tokenHash,
        },
        data: {
          status: OrgInvitationStatus.ACCEPTED,
          acceptedAt: new Date(),
        },
      });
      if (count === 0) {
        throw new MembersServiceOpaqueInvitationError();
      }

      const email = invitation.email;
      const existing = await tx.user.findUnique({ where: { email } });
      const user =
        existing ??
        (await tx.user.create({
          data: {
            email,
            name: email.split('@')[0],
            passwordHash: await this.passwords.hash(dto.password),
          },
        }));
      if (existing && !(await this.passwords.verify(dto.password, existing.passwordHash))) {
        // Account-proof failure must be as opaque as an invalid token.
        throw new MembersServiceOpaqueInvitationError();
      }

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
        },
      });
      await tx.orgInvitation.update({
        where: { id: invitation.id },
        data: { acceptedByUserId: user.id },
      });

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: invitation.organizationId },
        select: { id: true, name: true },
      });
      return {
        organizationId: organization.id,
        organizationName: organization.name,
        role: membership.role,
        email,
      };
    });

    this.logger.log(
      `Invitation accepted: ${claimed.email} joined organization ` +
        `${claimed.organizationId} as ${claimed.role}`,
    );
    return claimed;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private mapInvitationConflict(error: unknown, email: string): Error {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException(
        `A pending invitation for ${email} already exists in this organization`,
      );
    }
    return error as Error;
  }

  private toInvitationResponse(
    row: Prisma.OrgInvitationGetPayload<Record<string, never>>,
  ): InvitationResponseDto {
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Internal sentinel for every "token is unusable" case — mapped to one opaque
 * 410 by the controller so unknown/expired/revoked/accepted/wrong-password are
 * indistinguishable in both status and body (org-membership spec).
 */
export class MembersServiceOpaqueInvitationError extends Error {
  constructor() {
    super('Invitation is no longer valid');
  }
}
