import { ApiProperty } from '@nestjs/swagger';

/**
 * One recorded delivery POST attempt — the full attempt trail is returned by
 * the delivery detail and deliveries list so integrators can debug
 * rejections, redeliveries, and dead-letters without support (design D2).
 */
export class WebhookDeliveryAttemptDto {
  @ApiProperty({
    example: 'e2a4a0d9-6fbd-46b1-a2d9-16ec3dd1c1cf',
    description: 'Unique attempt row identifier (UUID)',
  })
  id!: string;

  @ApiProperty({
    example: 1,
    description: '1-based POST attempt number for this delivery',
  })
  attemptNumber!: number;

  @ApiProperty({
    example: 'FAILED',
    description: 'DELIVERED (endpoint acknowledged 2xx) or FAILED (transport error or retransmission deadline)',
  })
  outcome!: 'DELIVERED' | 'FAILED';

  @ApiProperty({
    example: 503,
    nullable: true,
    description: 'HTTP response status. Null when the transport failed before a response.',
  })
  responseStatus!: number | null;

  @ApiProperty({
    example: 'connect timeout after 10000ms',
    nullable: true,
    description: 'Transport error message. Null for acknowledged responses.',
  })
  error!: string | null;

  @ApiProperty({
    example: '2026-10-16T09:00:07.000Z',
    description: 'ISO-8601 attempt timestamp',
  })
  createdAt!: string;
}

/**
 * The full delivery representation (integrator-webhooks): terminal notification
 * payload as snapshotted at intent-creation time, delivery lifecycle state,
 * and the append-only attempt trail.
 */
export class WebhookDeliveryResponseDto {
  @ApiProperty({
    example: 'b7c1f9e0-3ac2-4a8e-8c33-5dbaa9b40d3f',
    description: 'Unique delivery identifier (UUID)',
  })
  id!: string;

  @ApiProperty({
    example: '9f1d3c66-4b5e-4b1f-9d18-7b2e6a0c1f66',
    nullable: true,
    description: 'Target endpoint. Null only after the endpoint was deleted (history preserved).',
  })
  webhookEndpointId!: string | null;

  @ApiProperty({
    example: 'https://integrator.example.com/payroll/hooks',
    description: 'URL snapshot from intent-creation time (never rewritten).',
  })
  url!: string;

  @ApiProperty({
    example: '7a1e6d41-ecdc-4d0d-ac7f-906d987d1e6f',
    description: 'The terminal event this notification announces',
  })
  eventId!: string;

  @ApiProperty({
    example: 'SUCCESS',
    description: 'Terminal status: SUCCESS, FAILED, or CANCELLED',
  })
  terminalStatus!: 'SUCCESS' | 'FAILED' | 'CANCELLED';

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The exact JSON body delivered (pre-rendered at intent creation).',
  })
  payload!: Record<string, unknown>;

  @ApiProperty({
    example: 'PENDING',
    description: 'PENDING, DELIVERED, or DEAD_LETTERED',
  })
  status!: 'PENDING' | 'DELIVERED' | 'DEAD_LETTERED';

  @ApiProperty({
    example: 2,
    description: 'POST attempts made so far (0 for untouched pending rows)',
  })
  attempts!: number;

  @ApiProperty({
    example: '2026-10-16T09:01:00.000Z',
    nullable: true,
    description: 'Next scheduled redelivery time (backoff). Null once terminal.',
  })
  nextAttemptAt!: string | null;

  @ApiProperty({
    example: '2026-10-16T09:00:04.000Z',
    nullable: true,
    description: 'Acknowledgement time (first 2xx). Null until delivered.',
  })
  deliveredAt!: string | null;

  @ApiProperty({
    example: 'endpoint_rejected',
    nullable: true,
    description: 'Why the delivery dead-lettered. Null unless DEAD_LETTERED.',
  })
  deadLetterReason!: string | null;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    description: 'ISO-8601 intent-creation timestamp',
  })
  createdAt!: string;

  @ApiProperty({
    type: WebhookDeliveryAttemptDto,
    isArray: true,
    description: 'Append-only POST attempt trail (ascending)',
  })
  attemptTrail!: WebhookDeliveryAttemptDto[];
}
