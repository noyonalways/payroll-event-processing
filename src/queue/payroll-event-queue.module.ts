import { Module } from '@nestjs/common';
import { QueueModule } from '@repo/database';
import { PayrollEventQueueService } from './payroll-event-queue.service';

/**
 * Provides the queue PRODUCER — `PayrollEventQueueService` — for both Nest
 * applications (the API enqueues on submit; the worker's relay re-enqueues on
 * completion). The producer carries the per-employee FIFO rule:
 *
 * Per-employee FIFO is achieved with `jobId = perEmployeeJobId(...)`; the
 * organization qualifies the key because employee numbers are tenant-local —
 * two organizations using the same employee number must NOT share a queue slot.
 *
 * This module lives with the business code (design D3): the job-identity rule
 * is a correctness invariant, not a connection setting. It imports the database
 * package's `QueueModule`, whose re-exported `BullModule` registers the
 * `payroll-events` queue token that `@InjectQueue` resolves here.
 */
@Module({
  imports: [QueueModule],
  providers: [PayrollEventQueueService],
  exports: [PayrollEventQueueService],
})
export class PayrollEventQueueModule {}

