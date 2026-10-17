import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@repo/database';

/**
 * Refresh-token + reset-token retention sweep (auth-hardening design D4):
 * one bounded DELETE per category per tick, on a setTimeout CHAIN in the
 * worker (never the API process). Failure is contained: log, retry next tick.
 *
 * What is deleted vs preserved:
 * - refresh tokens EXPIRED permanently (their life is over), OR revoked AND
 *   older than the retention window (reuse-detection tombstones survive the
 *   investigation window, then age out);
 * - password-reset tokens past their validity + the same retention.
 * Anything live (unexpired, unrevoked) is structurally invisible to the
 * WHERE clauses. A swept token cannot be re-presented for refresh anyway
 * (expiry/reuse checks), so storage is the only thing reclaimed.
 */
@Injectable()
export class AuthSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthSweepService.name);
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.intervalMs = config.get<number>('AUTH_SWEEP_INTERVAL_MS') ?? 3_600_000;
    const retentionDays = config.get<number>('AUTH_TOKEN_RETENTION_DAYS') ?? 7;
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  }

  onModuleInit(): void {
    this.scheduleNext(0);
    this.logger.log(
      `Auth retention sweep scheduled every ${this.intervalMs}ms ` +
        `(revoked tokens retained ${this.retentionMs / 86_400_000} days)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.sweepOnce();
    }, delayMs);
    this.timer.unref?.();
  }

  /**
   * One bounded sweep. Returns the deleted row count; exposed for tests.
   * A failure logs and lets the NEXT tick retry — nothing else is disturbed.
   */
  async sweepOnce(): Promise<{ refreshTokens: number; resetTokens: number }> {
    try {
      const now = new Date();
      const retentionCutoff = new Date(now.getTime() - this.retentionMs);

      const refreshTokens = await this.prisma.refreshToken.deleteMany({
        where: {
          OR: [
            // Expired: the token's life is over, storage is all that is left.
            { expiresAt: { lt: now } },
            // Revoked tombstones age out AFTER the retention window — they
            // stay queryable for reuse investigations before deletion.
            { revokedAt: { not: null, lt: retentionCutoff } },
          ],
        },
      });

      const resetTokens = await this.prisma.passwordResetToken.deleteMany({
        where: {
          expiresAt: { lt: retentionCutoff },
        },
      });

      this.logger.log(
        `Auth sweep: ${refreshTokens.count} refresh + ${resetTokens.count} reset token(s) deleted`,
      );
      return { refreshTokens: refreshTokens.count, resetTokens: resetTokens.count };
    } catch (error) {
      this.logger.error(
        `Auth sweep failed (retrying next tick): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { refreshTokens: 0, resetTokens: 0 };
    }
  }
}
