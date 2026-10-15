/**
 * Public surface of @repo/core — the business logic and BOTH composition roots
 * (design D4). Compiled package (design D6): entrypoints point at dist/, so a
 * downstream `nest build` follows declarations instead of dragging this source
 * tree into its own rootDir.
 *
 * The composition roots come first; the remaining exports are the collaborators
 * the entrypoints and the end-to-end suites reach for across the boundary.
 */
export { AppModule } from './app.module';
export { WorkerModule } from './worker/worker.module';
export { resolveStageEnvFile } from './config/env-file';

export { HttpExceptionFilter } from './common/filters/http-exception.filter';
export { logLevelsFor } from './common/logger/log-levels';
export { setupSwagger } from './common/swagger/setup-swagger';

export { HealthModule } from './common/health/health.module';
export { AuthModule } from './auth/auth.module';
export { IdempotencyModule } from './common/idempotency/idempotency.module';
export { IdempotencyService } from './common/idempotency/idempotency.service';
export { EventsModule } from './events/events.module';
export { ProcessingModule } from './processing/processing.module';
export { EventClaim } from './processing/event-claim';
export { HeartbeatService } from './processing/heartbeat.service';
export { HandlerRegistry } from './processing/handler-registry';
export {
  SimulatedPayrollProvider,
  FailureConfig,
} from './processing/simulated-payroll-provider';
export { PayloadValidator } from './events/payload.validator';
export { PayloadDtoRegistry } from './events/dto/payload-registry';

export { PayrollEventQueueModule } from './queue/payroll-event-queue.module';
export {
  PayrollEventQueueService,
  PayrollEventJobInput,
  perEmployeeJobId,
} from './queue/payroll-event-queue.service';
