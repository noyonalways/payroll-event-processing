import { ApiProperty } from '@nestjs/swagger';
import { WorkerLivenessDto } from './worker-liveness.dto';

/**
 * Response body of GET /health.
 *
 * A class (not an interface) is required so Swagger can introspect the schema.
 */
export class HealthResponseDto {
  @ApiProperty({
    enum: ['ok', 'degraded'],
    example: 'ok',
    description:
      'Overall service status. degraded when a dependency is unreachable, any worker ' +
      'heartbeat is stale, or the queue reports stalled jobs.',
  })
  status!: 'ok' | 'degraded';

  @ApiProperty({
    enum: ['ok', 'error'],
    example: 'ok',
    description: 'PostgreSQL connectivity (SELECT 1)',
  })
  db!: 'ok' | 'error';

  @ApiProperty({
    enum: ['ok', 'error'],
    example: 'ok',
    description: 'Redis connectivity (PING)',
  })
  redis!: 'ok' | 'error';

  @ApiProperty({ example: 42, description: 'Seconds since process start' })
  uptime!: number;

  @ApiProperty({ example: '2026-08-26T00:40:12.000Z', description: 'ISO-8601 timestamp' })
  timestamp!: string;

  @ApiProperty({
    type: () => [WorkerLivenessDto],
    example: [{ workerId: 'WIN-HOST123:4500', hostname: 'WIN-HOST123', lastSeenAt: '2026-08-26T00:40:12.000Z', stale: false }],
    description:
      'All recorded worker heartbeats, newest first. A worker is `stale` when its last ' +
      'heartbeat is older than HEALTH_WORKER_STALE_MS (default 15000).',
  })
  workers!: WorkerLivenessDto[];

  @ApiProperty({
    example: 0,
    description:
      'Jobs BullMQ has marked as stalled (workers that stopped extending their lock). ' +
      'Any stalled job degrades the overall status (R4).',
  })
  stalled!: number;
}