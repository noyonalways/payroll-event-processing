import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
} from 'class-validator';
import { WebhookUrlConstraint } from './webhook-url.constraint';

/**
 * Body of POST /webhook-endpoints (integrator-webhooks): register one HTTPS
 * callback for the caller's organization. The response — not any later read —
 * carries the signing secret in full, exactly once.
 */
export class CreateWebhookEndpointDto {
  @ApiProperty({
    example: 'acme-hris',
    description:
      'Organization-unique label for the callback. Used to tell multiple endpoints apart.',
  })
  @IsString({ message: 'label must be a string' })
  @IsNotEmpty({ message: 'label is required' })
  @MaxLength(100, { message: 'label must be at most 100 characters' })
  label!: string;

  @ApiProperty({
    example: 'https://integrator.example.com/payroll/hooks',
    description:
      'HTTPS callback URL. Secret-bearing plaintext transports (http) are rejected.',
  })
  @Validate(WebhookUrlConstraint)
  url!: string;
}

/**
 * Body of PATCH /webhook-endpoints/:id — every field optional; omitted fields
 * stay unchanged. The signing secret is never patchable (rotate by deleting
 * and re-registering the endpoint).
 */
export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({
    example: 'acme-hris-primary',
    description: 'Replacement organization-unique label.',
  })
  @IsOptional()
  @IsString({ message: 'label must be a string' })
  @IsNotEmpty({ message: 'label must not be blank' })
  @MaxLength(100, { message: 'label must be at most 100 characters' })
  label?: string;

  @ApiPropertyOptional({
    example: 'https://integrator.example.com/payroll/hooks/v2',
    description: 'Replacement HTTPS callback URL (loopback http:// allowed for local receivers).',
  })
  @IsOptional()
  @Validate(WebhookUrlConstraint)
  url?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Deactivate to stop new delivery intents (pending rows drain once reactivated).',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean({ message: 'active must be a boolean' })
  active?: boolean;
}
