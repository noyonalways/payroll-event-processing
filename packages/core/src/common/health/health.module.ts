import { Module } from '@nestjs/common';
import { QueueModule } from '@repo/database';
import { HealthController } from './health.controller';

@Module({
  // QueueModule exports BullModule, providing the `@InjectQueue` provider the
  // controller needs for the stalled-job count.
  imports: [QueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
