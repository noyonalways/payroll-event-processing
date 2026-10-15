import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { MembershipRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCESS_TOKEN_TYPE,
  AUTH_DEFAULT_ACCESS_TTL,
  AUTH_DEFAULT_REFRESH_TTL_DAYS,
} from './auth.constants';

/** Number of random bytes in a refresh token (256 bits, base64url-encoded). */
const REFRESH_TOKEN_BYTES = 32;

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  /** Human-readable access-token lifetime as configured (e.g. `15m`). */
  accessTokenExpiresIn: string;
  refreshTokenExpiresAt: Date;
}

export interface RotatedSessionRef {
  userId: string;
  organizationId: string;
}

/**
 * Mints and rotates the two credentials of a session.
 *
 * **Access token** — a signed JWT carrying `{ sub, org, role, type }`. Short-lived
 * and verified without touching the database, which is what keeps the guard on the
 * hot path cheap. Its `org` claim is the tenancy boundary.
 *
 * **Refresh token** — an opaque 256-bit random value, stored only as a SHA-256
 * digest. It is a database-backed handle, so it can actually be revoked; a JWT
 * could not be, short of a denylist that reintroduces the same lookup.
 *
 * Rotation (design D5): a refresh consumes the presented row and issues a new pair.
 * Presenting an already-revoked token means either a replay or a stolen copy, and
 * the response is to revoke every live token for that user — the legitimate client
 * logs in again, the thief's copy is dead. SHA-256 (not scrypt) is correct here:
 * the input is high-entropy random, so it is not brute-forceable and the hash is
 * on a per-refresh hot path.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessTtl: string;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.accessTtl =
      config.get<string>('AUTH_ACCESS_TOKEN_TTL') ?? AUTH_DEFAULT_ACCESS_TTL;
    this.refreshTtlDays =
      config.get<number>('AUTH_REFRESH_TOKEN_TTL_DAYS') ??
      AUTH_DEFAULT_REFRESH_TTL_DAYS;
  }

  /** Signs a fresh access token and persists a new refresh-token handle. */
  async issueSession(
    userId: string,
    organizationId: string,
    role: MembershipRole,
  ): Promise<IssuedSession> {
    const accessToken = await this.jwtService.signAsync(
      { sub: userId, org: organizationId, role, type: ACCESS_TOKEN_TYPE },
      // The config value is a Joi-validated string (`15m`); jsonwebtoken's own type
      // is a template-literal union of ms() formats, which a runtime string cannot
      // satisfy statically. Cast at this one boundary, not on the config field, so
      // the rest of the service keeps a plain string.
      { expiresIn: this.accessTtl as JwtSignOptions['expiresIn'] },
    );

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshTokenExpiresAt = this.refreshExpiry();

    await this.prisma.refreshToken.create({
      data: {
        userId,
        organizationId,
        tokenHash: this.hash(refreshToken),
        expiresAt: refreshTokenExpiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: this.accessTtl,
      refreshTokenExpiresAt,
    };
  }

  /**
   * Consumes a refresh token and returns the session it stood for. The caller
   * re-validates the membership and then calls `issueSession` for the new pair.
   *
   * Every failure path throws the same opaque 401 — an attacker learns whether a
   * token existed only by the fact that reuse kills the whole family.
   */
  async rotate(presentedToken: string): Promise<RotatedSessionRef> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(presentedToken) },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.revokedAt) {
      // Replay of an already-rotated token: assume the family is compromised.
      const { count } = await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token reuse detected for user ${record.userId} — revoked ${count} live token(s)`,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    return { userId: record.userId, organizationId: record.organizationId };
  }

  /**
   * Revokes a single refresh token. Idempotent and never throws on an unknown or
   * already-revoked value: logout must always succeed from the client's view, and
   * a failure here would leak whether the token was real.
   */
  async revoke(presentedToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(presentedToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000);
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
