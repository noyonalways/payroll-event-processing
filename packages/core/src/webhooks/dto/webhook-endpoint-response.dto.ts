import { ApiProperty } from '@nestjs/swagger';

/**
 * Representation of one webhook endpoint (integrator-webhooks). Returned by
 * every read and by PATCH; `signingSecret` is included ONLY in the create
 * response — list and read responses never expose it.
 */
export class WebhookEndpointResponseDto {
  @ApiProperty({
    example: '9f1d3c66-4b5e-4b1f-9d18-7b2e6a0c1f66',
    description: 'Unique endpoint record identifier (UUID)',
  })
  id!: string;

  @ApiProperty({
    example: 'acme-hris',
    description: 'Organization-unique label.',
  })
  label!: string;

  @ApiProperty({
    example: 'https://integrator.example.com/payroll/hooks',
    description: 'HTTPS callback URL deliveries are POSTed to.',
  })
  url!: string;

  @ApiProperty({
    example: true,
    description:
      'Whether new delivery intents are produced. Inactive endpoints receive none; ' +
      'pending rows of a reactivated endpoint drain normally.',
  })
  active!: boolean;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    description: 'ISO-8601 creation timestamp',
  })
  createdAt!: string;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    description: 'ISO-8601 last-update timestamp',
  })
  updatedAt!: string;
}

/**
 * The create response: the endpoint representation PLUS the one-time signing
 * secret. {@link WebhookEndpointResponseDto} omits the secret on purpose —
 * this DTO exists so Swagger shows customers exactly the one place it appears.
 */
export class WebhookEndpointCreatedDto extends WebhookEndpointResponseDto {
  @ApiProperty({
    example: 'Kk3rWvYCAq0T5wWq+AGmYWCBU5kz0B7NQdDxAa1PLzc=',
    description:
      'Signing secret (base64). Shown ONLY here; HMAC-SHA256 webhook ' +
      'signatures are computed with it. Never retrievable afterwards.',
  })
  signingSecret!: string;
}
