import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { IdempotencySweeper } from './idempotency.sweeper';

/**
 * Shared idempotency layer. PrismaModule (PrismaService) and ConfigModule
 * (ConfigService) are both @Global(), so no imports are needed here. Not global
 * itself — modules opt in per feature.
 */
@Module({
  providers: [IdempotencyService, IdempotencySweeper],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}