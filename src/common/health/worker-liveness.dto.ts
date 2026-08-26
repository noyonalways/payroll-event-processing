import { ApiProperty } from '@nestjs/swagger';

/**
 * One live (or stale) worker entry in `GET /health`.
 *
 * A class (not an interface) is required so Swagger can introspect the schema.
 */
export class WorkerLivenessDto {
  @ApiProperty({
    example: 'WIN-HOST123:4500',
    description:
      'Worker id — the WORKER_ID env var when set, otherwise `${hostname}:${pid}`',
  })
  workerId!: string;

  @ApiProperty({
    example: 'WIN-HOST123',
    description: 'Hostname the worker process runs on',
  })
  hostname!: string;

  @ApiProperty({
    example: '2026-08-26T00:40:12.000Z',
    description: 'Most recent heartbeat timestamp (ISO-8601)',
  })
  lastSeenAt!: string;

  @ApiProperty({
    example: false,
    description:
      'true when the last heartbeat is older than HEALTH_WORKER_STALE_MS — the worker is ' +
      'assumed crashed or hung, and the overall /health status degrades',
  })
  stale!: boolean;
}