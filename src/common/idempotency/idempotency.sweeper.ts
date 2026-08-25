import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

const IDEMPOTENCY_DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Periodically purges expired idempotency records so the store stays bounded.
 * A lifecycle-hook setInterval (no scheduler dependency): unref'd so short-lived
 * processes (tests, workers) are not held open, and errors are logged, never
 * fatal — a missed sweep is recovered by the next tick.
 */
@Injectable()
export class IdempotencySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencySweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs =
      this.configService.get<number>('IDEMPOTENCY_SWEEP_INTERVAL_MS') ??
      IDEMPOTENCY_DEFAULT_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.sweepNow().catch((error) => {
        this.logger.error(
          `Idempotency sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Deletes expired records; returns the number purged. Exposed for tests. */
  async sweepNow(): Promise<number> {
    const { count } = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) {
      this.logger.log(`Purged ${count} expired idempotency record(s)`);
    }
    return count;
  }
}