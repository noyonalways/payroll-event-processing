import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Membership, MembershipRole, Organization, Prisma, User } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedActor } from './authenticated-actor';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ActorIdentityDto, SessionResponseDto } from './dto/session-response.dto';
import { PasswordService } from './password.service';
import { IssuedSession, TokenService } from './token.service';

/** Maximum attempts to find an unused organization slug before giving up. */
const SLUG_ATTEMPTS = 5;

type MembershipWithTenant = Membership & {
  organization: Organization;
  user: User;
};

/**
 * Authentication and tenant membership.
 *
 * Design notes that matter for tenancy:
 *
 * - **Registration creates a tenant.** The registrant becomes its OWNER. There is
 *   no path to join an existing organization without an invitation (a later
 *   change), so nothing here can place a user inside someone else's tenant.
 * - **A session is bound to one organization.** The organization is decided at
 *   login and baked into both tokens; the refresh token records it too, so no
 *   later request can steer a session into a different tenant.
 * - **Login errors are opaque.** A wrong password and an unknown email produce the
 *   same 401, and the unknown-email path still runs a hash comparison so the two
 *   cannot be told apart by response time either.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Lazily built, used only to equalize timing on an unknown email. */
  private dummyDigest?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<SessionResponseDto> {
    const email = this.normalizeEmail(dto.email);
    const passwordHash = await this.passwords.hash(dto.password);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const membership = await this.createTenantWithOwner({
      email,
      passwordHash,
      name: dto.name ?? null,
      organizationName: dto.organizationName.trim(),
    });

    this.logger.log(
      `Registered organization ${membership.organizationId} with owner ${membership.userId}`,
    );

    const session = await this.tokens.issueSession(
      membership.userId,
      membership.organizationId,
      membership.role,
    );

    return this.toSessionResponse(session, membership);
  }

  async login(dto: LoginDto): Promise<SessionResponseDto> {
    const email = this.normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      await this.equalizeTiming(dto.password);
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await this.passwords.verify(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const membership = await this.resolveMembership(user.id, dto.organizationId);
    const session = await this.tokens.issueSession(
      membership.userId,
      membership.organizationId,
      membership.role,
    );

    this.logger.log(
      `User ${user.id} signed in to organization ${membership.organizationId}`,
    );

    return this.toSessionResponse(session, membership);
  }

  /**
   * Rotates a refresh token into a new session. The membership row is re-read
   * here — not trusted from the token — so removing a user from an organization
   * takes effect at the next refresh instead of at access-token expiry.
   */
  async refresh(refreshToken: string): Promise<SessionResponseDto> {
    const { userId, organizationId } = await this.tokens.rotate(refreshToken);

    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: { organization: true, user: true },
    });

    if (!membership) {
      // The token was genuine, but the caller no longer belongs to the tenant.
      this.logger.warn(
        `Refresh rejected: user ${userId} is no longer a member of ${organizationId}`,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.tokens.issueSession(
      membership.userId,
      membership.organizationId,
      membership.role,
    );
    return this.toSessionResponse(session, membership);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  /**
   * Read-only identity for the caller's current tenant — the endpoint a client
   * uses to learn who it is and which organization it is acting in.
   */
  async me(actor: AuthenticatedActor): Promise<ActorIdentityDto> {
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: actor.userId,
          organizationId: actor.organizationId,
        },
      },
      include: { organization: true, user: true },
    });

    if (!membership) {
      throw new UnauthorizedException('Authenticated organization is no longer accessible');
    }

    return this.toActorIdentity(membership);
  }

  /**
   * Creates the tenant, its owner, and the membership in ONE transaction: a
   * partially created tenant would be an organization nobody can sign in to.
   *
   * The slug is derived from the organization name, and a collision retries with a
   * random suffix — organizations must be able to share a name, so the slug is
   * generated rather than rejected.
   */
  private async createTenantWithOwner(input: {
    email: string;
    passwordHash: string;
    name: string | null;
    organizationName: string;
  }): Promise<MembershipWithTenant> {
    const baseSlug = slugify(input.organizationName);

    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
      const slug =
        attempt === 0 ? baseSlug : `${baseSlug}-${randomBytes(3).toString('hex')}`;

      try {
        return await this.prisma.$transaction(async (tx) => {
          const organization = await tx.organization.create({
            data: { name: input.organizationName, slug },
          });
          const user = await tx.user.create({
            data: {
              email: input.email,
              passwordHash: input.passwordHash,
              name: input.name,
            },
          });
          return tx.membership.create({
            data: {
              userId: user.id,
              organizationId: organization.id,
              role: MembershipRole.OWNER,
            },
            include: { organization: true, user: true },
          });
        });
      } catch (error) {
        if (this.isSlugCollision(error) && attempt < SLUG_ATTEMPTS - 1) {
          continue;
        }
        // A concurrent registration for the same email wins the users_email_key
        // race; surface it as the same conflict the pre-check would have raised.
        if (this.isUniqueViolationOn(error, 'email')) {
          throw new ConflictException('An account with this email already exists');
        }
        throw error;
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new ConflictException('Could not allocate a unique organization slug');
  }

  /**
   * Picks the organization a login signs in to. An account in exactly one tenant
   * needs no hint; an account in several must name one, rather than having a
   * tenant silently chosen for it.
   */
  private async resolveMembership(
    userId: string,
    requestedOrganizationId?: string,
  ): Promise<MembershipWithTenant> {
    if (requestedOrganizationId) {
      const membership = await this.prisma.membership.findUnique({
        where: { userId_organizationId: { userId, organizationId: requestedOrganizationId } },
        include: { organization: true, user: true },
      });
      if (!membership) {
        // Same opaque 401 as a bad password: whether the account is a member of a
        // given organization is not something an unauthenticated caller may probe.
        throw new UnauthorizedException('Invalid email or password');
      }
      return membership;
    }

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { organization: true, user: true },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) {
      throw new ForbiddenException('This account does not belong to any organization');
    }
    if (memberships.length > 1) {
      throw new BadRequestException(
        'This account belongs to multiple organizations — supply organizationId to choose one',
      );
    }
    return memberships[0];
  }

  private toSessionResponse(
    session: IssuedSession,
    membership: MembershipWithTenant,
  ): SessionResponseDto {
    return {
      ...this.toActorIdentity(membership),
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenType: 'Bearer',
      expiresIn: session.accessTokenExpiresIn,
      refreshExpiresAt: session.refreshTokenExpiresAt.toISOString(),
    };
  }

  private toActorIdentity(membership: MembershipWithTenant): ActorIdentityDto {
    return {
      user: {
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.name,
      },
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      role: membership.role,
    };
  }

  /** Emails are case-insensitive; the lowercased form is the unique key. */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Runs a verification against a throwaway digest so a login for an unknown
   * email costs the same as one for a known email. Without it, response time
   * alone reveals which emails have accounts.
   */
  private async equalizeTiming(password: string): Promise<void> {
    this.dummyDigest ??= await this.passwords.hash(randomBytes(24).toString('hex'));
    await this.passwords.verify(password, this.dummyDigest);
  }

  private isUniqueViolationOn(error: unknown, field: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }
    const target = error.meta?.target;
    return Array.isArray(target) ? target.includes(field) : target === field;
  }

  private isSlugCollision(error: unknown): boolean {
    return this.isUniqueViolationOn(error, 'slug');
  }
}

/**
 * Derives a URL-safe slug from an organization name. Non-alphanumerics collapse to
 * hyphens; an all-symbol name falls back to a fixed stem so the column stays valid.
 */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug === '' ? 'org' : slug;
}
