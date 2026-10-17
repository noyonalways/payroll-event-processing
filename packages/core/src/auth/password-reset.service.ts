import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '@repo/database';
import { PasswordService } from './password.service';

/** Internal sentinel for every unusable reset token (single opaque error). */
export class DeadResetTokenError extends Error {
  constructor() {
    super('Reset token is no longer valid');
  }
}

/**
 * Password reset (auth-hardening design D2): forgot-password mints a
 * single-use hashed token ONLY for existing accounts (unknown emails produce
 * the identical `202` and create nothing — anti-enumeration), and
 * reset-password completes one atomic transaction: guarded token claim,
 * digest swap, refresh-family revocation (a reset never leaves stolen
 * sessions alive), lockout clear. Token discipline mirrors refresh tokens:
 * 32 random bytes shown once, SHA-256 stored.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    config: ConfigService,
  ) {
    const minutes = config.get<number>('AUTH_RESET_TTL_MINUTES') ?? 30;
    this.ttlMs = minutes * 60 * 1000;
  }

  /**
   * Always `202`-shaped: `true` only means "an account existed". The caller
   * (controller) returns the SAME body either way.
   */
  async requestReset(email: string): Promise<{ created: boolean; token: string | null }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      this.logger.log('Forgot-password for unknown email — no-op (anti-enumeration)');
      return { created: false, token: null };
    }

    // Invalidate prior unused tokens for the account, then mint one fresh
    // single-use raw token (stored hashed; recoverable never).
    await this.prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });
    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hash(rawToken),
        expiresAt: new Date(Date.now() + this.ttlMs),
      },
    });
    this.logger.log(`Password reset token issued for user ${user.id}`);
    return { created: true, token: rawToken };
  }

  /**
   * Completes the reset in ONE transaction: guarded single-use claim (`usedAt`
   * from null), digest swap, FAMILY-WIDE refresh revocation (all live tokens
   * for the user die), lockout clear. Any dead token → DeadResetTokenError →
   * the controller's one opaque 410.
   */
  async reset(token: string, newPassword: string): Promise<void> {
    const tokenHash = this.hash(token.trim());
    await this.prisma.$transaction(async (tx) => {
      const record = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
      const valid =
        record !== null && record.usedAt === null && record.expiresAt > new Date();
      if (!valid) {
        throw new DeadResetTokenError();
      }

      // Guarded claim — the loser of a concurrent double-redemption race
      // matches 0 rows and aborts with nothing changed.
      const { count } = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (count === 0) {
        throw new DeadResetTokenError();
      }

      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await this.passwords.hash(newPassword),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      // A reset KILLS sessions: every live refresh token for the user is
      // revoked, so a stolen-family attacker is locked out with the password.
      const { count: revoked } = await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      this.logger.log(
        `Password reset completed for user ${record.userId} — ` +
          `${revoked} live refresh token(s) revoked`,
      );
    });
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
