import { ApiProperty } from '@nestjs/swagger';

/**
 * Response body of GET /health.
 *
 * A class (not an interface) is required so Swagger can introspect the schema.
 */
export class HealthResponseDto {
  @ApiProperty({
    enum: ['ok', 'degraded'],
    example: 'ok',
    description: 'Overall service status. degraded when any dependency is unreachable.',
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

  @ApiProperty({ example: '2026-08-24T10:15:30.000Z', description: 'ISO-8601 timestamp' })
  timestamp!: string;
}